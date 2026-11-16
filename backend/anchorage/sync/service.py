"""Sync service: CTI sources → normalized, merged IOCs.

* one run at a time (pg advisory lock held on a dedicated connection)
* incremental (hourly/manual): cursor rowid/last_seen + per-row hash diff
* full (daily): every row, reconcile rows that vanished from a source, aging, rule re-run
* resumable: cursors and row hashes commit per batch; re-running is idempotent
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.core.bus import CONTROL, EVENTS, get_bus
from anchorage.core.db import get_engine, session_scope, sessionmaker
from anchorage.core.runtime_settings import RuntimeSettings, load_runtime_settings
from anchorage.ioc.normalize import Rejected, Skip, normalize
from anchorage.ioc.records import RawIoc, candidate_from, comparable, finalize, merge
from anchorage.models import Ioc, SourceCursor, SourceRowState, SyncRun
from anchorage.models.enums import SyncKind, SyncStatus
from anchorage.sources import build_sources
from anchorage.sources.base import Cursor, IocSource, SourceRow, TableHandle

log = logging.getLogger("anchorage.sync")

ADVISORY_LOCK_KEY = 0x0A4C_5E01  # arbitrary, stable
STALE_AFTER = timedelta(minutes=10)
MAX_ERROR_SAMPLES = 50

IOC_COLUMNS = ("type", "value_norm", "value_raw", "ip", "net", "port", "asn", "host", "host_rev", "sources",
               "source_count", "source_refs", "first_seen", "last_seen", "tlp", "tlp_rank", "score", "confidence",
               "tags", "malware_families", "actors", "mitre_ids", "status", "expires_at", "is_demo")


class RunStats:
    def __init__(self) -> None:
        self.c: Counter[str] = Counter()
        self.errors: list[dict[str, Any]] = []
        self.per_table: dict[str, dict[str, int]] = {}
        self.reject_reasons: Counter[str] = Counter()

    def error(self, **kw: Any) -> None:
        if len(self.errors) < MAX_ERROR_SAMPLES:
            self.errors.append(kw)


class SyncService:
    def __init__(self, sources_factory: Callable[[], list[IocSource]] | None = None,
                 batch_size: int | None = None) -> None:
        from anchorage.core.config import get_settings

        self._sources_factory = sources_factory or build_sources
        self.batch_size = batch_size or get_settings().sync_batch_size

    # ------------------------------------------------------------- entry ---

    async def run(self, kind: str, triggered_by: str = "scheduler", run_id: int | None = None) -> SyncRun:
        """Execute a sync. Returns the finished SyncRun (status skipped when another run holds the lock)."""
        mode = "full" if kind == SyncKind.daily else "incremental"
        engine = get_engine()
        async with engine.connect() as lock_conn:
            got = (await lock_conn.execute(select(func.pg_try_advisory_lock(ADVISORY_LOCK_KEY)))).scalar()
            if not got:
                return await self._mark_skipped(kind, mode, triggered_by, run_id)
            try:
                return await self._run_locked(kind, mode, triggered_by, run_id)
            finally:
                await lock_conn.execute(select(func.pg_advisory_unlock(ADVISORY_LOCK_KEY)))
                await lock_conn.commit()

    async def _mark_skipped(self, kind: str, mode: str, who: str, run_id: int | None) -> SyncRun:
        async with session_scope() as s:
            if run_id is not None:  # queued manual runs stay queued; the worker retries them
                run = await s.get(SyncRun, run_id)
                assert run is not None
                return run
            run = SyncRun(kind=kind, mode=mode, status=SyncStatus.skipped, triggered_by=who,
                          started_at=datetime.now(UTC), finished_at=datetime.now(UTC),
                          errors=[{"error": "another sync is running"}])
            s.add(run)
        return run

    async def _run_locked(self, kind: str, mode: str, who: str, run_id: int | None) -> SyncRun:
        now = datetime.now(UTC)
        async with session_scope() as s:
            run = await s.get(SyncRun, run_id) if run_id else None
            if run is None:
                run = SyncRun(kind=kind, mode=mode, triggered_by=who)
                s.add(run)
            run.status, run.started_at, run.heartbeat_at = SyncStatus.running, now, now
            run.mode = mode
            await s.flush()
            run_pk = run.id
            rt = await load_runtime_settings(s)
        bus = get_bus()
        await bus.publish(EVENTS, "sync.started", {"run_id": run_pk, "kind": kind, "mode": mode})
        stats = RunStats()
        fatal: str | None = None
        try:
            sources = self._sources_factory()
            for source in sources:
                await self._sync_source(source, run_pk, mode, rt, stats)
            if mode == "full":
                stats.c["expired"] += await self._age(now)
            stats.c["flagged"] += await self._evaluate_rules()
        except Exception as exc:  # pragma: no cover - defensive; recorded on the run
            log.exception("sync %s failed", run_pk)
            fatal = f"{type(exc).__name__}: {exc}"
            stats.error(error=fatal)

        async with session_scope() as s:
            run = await s.get(SyncRun, run_pk)
            assert run is not None
            run.finished_at = datetime.now(UTC)
            run.new_count = stats.c["new"]
            run.updated_count = stats.c["updated"]
            run.unchanged_count = stats.c["unchanged"]
            run.expired_count = stats.c["expired"] + stats.c["retired"]
            run.rejected_count = stats.c["rejected"]
            run.skipped_count = stats.c["skipped"]
            run.flagged_count = stats.c["flagged"]
            run.errors = stats.errors
            run.stats = {"tables": stats.per_table, "reject_reasons": dict(stats.reject_reasons.most_common(20)),
                         "retired": stats.c["retired"], "aged": stats.c["expired"]}
            run.status = (SyncStatus.failed if fatal else
                          SyncStatus.partial if any("store" in e or "table" in e for e in stats.errors) else
                          SyncStatus.success)
        await bus.publish(EVENTS, "sync.finished", await _run_payload(run_pk))
        await bus.publish(CONTROL, "index.rebuild", {"reason": "sync", "run_id": run_pk})
        async with sessionmaker()() as s:
            done = await s.get(SyncRun, run_pk)
            assert done is not None
            return done

    # ------------------------------------------------------------ source ---

    async def _sync_source(self, source: IocSource, run_id: int, mode: str, rt: RuntimeSettings,
                           stats: RunStats) -> None:
        try:
            tables = await source.prepare()
        except Exception as exc:
            stats.error(source=source.name, store="*", error=f"prepare failed: {exc}")
            await source.close()
            return
        for err in getattr(source, "errors", []):
            stats.error(**err)
        enrichment = source.enrichment() if hasattr(source, "enrichment") else {}
        try:
            for table in tables:
                ok = await self._sync_table(source, table, run_id, mode, rt, stats, enrichment)
                if ok and mode == "full":
                    stats.c["retired"] += await self._reconcile_gone(table, run_id)
        finally:
            await source.close()

    async def _sync_table(self, source: IocSource, table: TableHandle, run_id: int, mode: str, rt: RuntimeSettings,
                          stats: RunStats, enrichment: dict[str, dict[str, list[str]]]) -> bool:
        key = table.source_key
        tstats: Counter[str] = Counter()
        try:
            skipped = await source.skipped_count(table)
            stats.c["skipped"] += skipped
            tstats["skipped"] += skipped
            cursor = await self._load_cursor(key) if (mode == "incremental" and table.supports_cursor) else None
            after = 0
            while True:
                rows = await source.fetch(table, after, self.batch_size, cursor)
                if not rows:
                    break
                after = rows[-1].rowid
                res = await self._process_batch(table, rows, run_id, mode, rt, enrichment, stats)
                tstats.update(res)
                await self._heartbeat(run_id)
                await get_bus().publish(EVENTS, "sync.progress", {
                    "run_id": run_id, "source": table.source, "table": table.table,
                    "processed": tstats["rows"], "new": stats.c["new"], "updated": stats.c["updated"]})
            stats.per_table[key] = dict(tstats)
            return True
        except Exception as exc:
            log.exception("table %s failed", key)
            stats.error(source=table.source, table=table.table, error=f"{type(exc).__name__}: {exc}")
            stats.per_table[key] = dict(tstats)
            return False

    async def _process_batch(self, table: TableHandle, rows: list[SourceRow], run_id: int, mode: str,
                             rt: RuntimeSettings, enrichment: dict[str, dict[str, list[str]]],
                             stats: RunStats) -> Counter[str]:
        res: Counter[str] = Counter(rows=len(rows))
        key = table.source_key
        enabled = frozenset(rt.enabled_types)
        async with session_scope() as s:
            prior = {r.row_key: r.row_hash for r in (await s.execute(
                select(SourceRowState.row_key, SourceRowState.row_hash).where(
                    SourceRowState.source_key == key,
                    SourceRowState.row_key.in_([r.raw.row_key for r in rows])))).all()}

            candidates: dict[tuple[str, str], dict[str, Any]] = {}
            contributing: Counter[tuple[str, str]] = Counter()
            states: list[dict[str, Any]] = []
            for row in rows:
                raw = row.raw
                h = raw.row_hash()
                state = {"source_key": key, "row_key": raw.row_key, "row_hash": h, "seen_run_id": run_id,
                         "ioc_type": None, "value_norm": None}
                try:
                    n = normalize(raw.ioc_type, raw.value, allow_private=rt.allow_private_ips, enabled_types=enabled)
                except Skip:
                    res["skipped"] += 1
                    stats.c["skipped"] += 1
                    states.append(state)
                    continue
                except Rejected as exc:
                    res["rejected"] += 1
                    stats.c["rejected"] += 1
                    stats.reject_reasons[str(exc)] += 1
                    states.append(state)
                    continue
                state["ioc_type"], state["value_norm"] = n.type, n.value
                states.append(state)
                if mode == "incremental" and prior.get(raw.row_key) == h:
                    res["unchanged"] += 1
                    stats.c["unchanged"] += 1
                    continue
                _enrich(raw, enrichment)
                cand = candidate_from(raw, n, rt.default_tlp)
                k = (n.type, n.value)
                candidates[k] = merge(candidates[k], cand) if k in candidates else cand
                contributing[k] += 1

            if candidates:
                await self._upsert(s, candidates, contributing, rt, res, stats)
            await self._save_states(s, states)
            await self._save_cursor(s, key, rows)
        return res

    async def _upsert(self, s: AsyncSession, candidates: dict[tuple[str, str], dict[str, Any]],
                      contributing: Counter[tuple[str, str]], rt: RuntimeSettings, res: Counter[str],
                      stats: RunStats) -> None:
        keys = list(candidates)
        cols = [getattr(Ioc, c) for c in IOC_COLUMNS]
        existing_rows = (await s.execute(
            select(Ioc.id, *cols).where(tuple_(Ioc.type, Ioc.value_norm).in_(keys)))).mappings().all()
        existing = {(r["type"], r["value_norm"]): dict(r) for r in existing_rows}
        now = datetime.now(UTC)
        inserts: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        for k, cand in candidates.items():
            days = rt.expiry_days.for_type(k[0])
            if k not in existing:
                row = finalize(dict(cand), days, now)
                row.update(created_at=now, updated_at=now, last_synced_at=now)
                inserts.append({c: row.get(c) for c in (*IOC_COLUMNS, "created_at", "updated_at", "last_synced_at")})
                res["new"] += 1
                stats.c["new"] += 1
                continue
            cur = existing[k]
            for ipcol in ("ip", "net"):  # asyncpg returns ipaddress objects
                if cur.get(ipcol) is not None:
                    cur[ipcol] = str(cur[ipcol])
            merged = finalize(merge(cur, cand), days, now)
            if comparable(merged) == comparable(cur):
                res["unchanged"] += contributing[k]
                stats.c["unchanged"] += contributing[k]
                continue
            upd = {c: merged.get(c) for c in IOC_COLUMNS if c not in ("type", "value_norm")}
            upd.update(id=cur["id"], updated_at=now, last_synced_at=now)
            updates.append(upd)
            res["updated"] += 1
            stats.c["updated"] += 1
        if inserts:
            await s.execute(pg_insert(Ioc).on_conflict_do_nothing(constraint="uq_iocs_type_value"), inserts)
        if updates:
            await s.execute(update(Ioc), updates)

    async def _save_states(self, s: AsyncSession, states: list[dict[str, Any]]) -> None:
        if not states:
            return
        dedup = {(st["source_key"], st["row_key"]): st for st in states}
        stmt = pg_insert(SourceRowState).values(list(dedup.values()))
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceRowState.source_key, SourceRowState.row_key],
            set_={"row_hash": stmt.excluded.row_hash, "seen_run_id": stmt.excluded.seen_run_id,
                  "ioc_type": stmt.excluded.ioc_type, "value_norm": stmt.excluded.value_norm})
        await s.execute(stmt)

    # ----------------------------------------------------------- cursors ---

    async def _load_cursor(self, key: str) -> Cursor:
        async with sessionmaker()() as s:
            row = await s.get(SourceCursor, key)
            return Cursor(row.max_rowid, row.max_last_seen) if row else Cursor()

    async def _save_cursor(self, s: AsyncSession, key: str, rows: list[SourceRow]) -> None:
        max_rowid = max(r.rowid for r in rows)
        seen = [r.last_seen_raw for r in rows if r.last_seen_raw]
        max_ls = max(seen) if seen else None
        stmt = pg_insert(SourceCursor).values(source_key=key, max_rowid=max_rowid, max_last_seen=max_ls,
                                               updated_at=datetime.now(UTC))
        stmt = stmt.on_conflict_do_update(
            index_elements=[SourceCursor.source_key],
            set_={"max_rowid": func.greatest(SourceCursor.max_rowid, stmt.excluded.max_rowid),
                  "max_last_seen": func.greatest(SourceCursor.max_last_seen, stmt.excluded.max_last_seen),
                  "updated_at": stmt.excluded.updated_at})
        await s.execute(stmt)

    # --------------------------------------------------------- reconcile ---

    async def _reconcile_gone(self, table: TableHandle, run_id: int) -> int:
        """Drop refs of source rows that disappeared; IOCs with no refs left are retired."""
        key = table.source_key
        retired = 0
        async with session_scope() as s:
            gone = (await s.execute(select(SourceRowState).where(
                SourceRowState.source_key == key,
                or_(SourceRowState.seen_run_id.is_(None), SourceRowState.seen_run_id != run_id)))).scalars().all()
            for st in gone:
                if st.ioc_type and st.value_norm:
                    ioc = (await s.execute(select(Ioc).where(Ioc.type == st.ioc_type,
                                                             Ioc.value_norm == st.value_norm))).scalar_one_or_none()
                    if ioc is not None:
                        ref_k = f"{key}:{st.row_key}"
                        refs = [r for r in (ioc.source_refs or []) if r.get("k") != ref_k]
                        if len(refs) != len(ioc.source_refs or []):
                            ioc.source_refs = refs
                            ioc.sources = sorted({r["source"] for r in refs if r.get("source")})
                            ioc.source_count = len(ioc.sources)
                            ioc.updated_at = datetime.now(UTC)
                            if not refs:
                                ioc.status = "retired"
                                retired += 1
                await s.delete(st)
        return retired

    async def _age(self, now: datetime) -> int:
        async with session_scope() as s:
            res = await s.execute(update(Ioc).where(Ioc.status == "active", Ioc.expires_at < now)
                                  .values(status="expired", updated_at=now))
            return int(res.rowcount or 0)

    async def _evaluate_rules(self) -> int:
        try:
            from anchorage.rules.engine import RuleEngine
        except ImportError:  # rules engine lands in M3
            return 0
        async with session_scope() as s:
            result = await RuleEngine(s).evaluate_all()
            return int(result.get("new_flags", 0))

    async def _heartbeat(self, run_id: int) -> None:
        async with session_scope() as s:
            await s.execute(update(SyncRun).where(SyncRun.id == run_id).values(heartbeat_at=datetime.now(UTC)))


def _enrich(raw: RawIoc, enrichment: dict[str, dict[str, list[str]]]) -> None:
    if not enrichment:
        return
    for fam in list(raw.malware_families):
        e = enrichment.get(fam.lower())
        if e:
            raw.actors = [*raw.actors, *e["actors"]]
            raw.mitre_ids = [*raw.mitre_ids, *e["mitre"]]


async def _run_payload(run_id: int) -> dict[str, Any]:
    async with sessionmaker()() as s:
        run = await s.get(SyncRun, run_id)
        return run_to_dict(run) if run else {"id": run_id}


def run_to_dict(run: SyncRun) -> dict[str, Any]:
    return {
        "id": run.id, "kind": run.kind, "mode": run.mode, "status": run.status, "triggered_by": run.triggered_by,
        "queued_at": run.queued_at, "started_at": run.started_at, "finished_at": run.finished_at,
        "heartbeat_at": run.heartbeat_at,
        "new": run.new_count, "updated": run.updated_count, "unchanged": run.unchanged_count,
        "expired": run.expired_count, "rejected": run.rejected_count, "skipped": run.skipped_count,
        "flagged": run.flagged_count, "errors": run.errors or [], "stats": run.stats or {},
    }


# -------------------------------------------------------------- queueing ---

async def enqueue(kind: str, triggered_by: str) -> SyncRun:
    async with session_scope() as s:
        active = (await s.execute(select(SyncRun).where(
            SyncRun.status.in_([SyncStatus.queued, SyncStatus.running])).order_by(SyncRun.id))).scalars().first()
        if active is not None:
            return active
        run = SyncRun(kind=kind, mode="full" if kind == SyncKind.daily else "incremental",
                      status=SyncStatus.queued, triggered_by=triggered_by)
        s.add(run)
    await get_bus().publish(CONTROL, "sync.wake", {"run_id": run.id})
    await get_bus().publish(EVENTS, "sync.queued", run_to_dict(run))
    return run


async def queue_or_run(kind: str, inline: bool = False, triggered_by: str = "cli") -> dict[str, Any]:
    if inline:
        return run_to_dict(await SyncService().run(kind, triggered_by))
    return run_to_dict(await enqueue(kind, triggered_by))


async def fail_stale_runs() -> int:
    cutoff = datetime.now(UTC) - STALE_AFTER
    async with session_scope() as s:
        res = await s.execute(update(SyncRun).where(
            SyncRun.status == SyncStatus.running,
            or_(SyncRun.heartbeat_at.is_(None), SyncRun.heartbeat_at < cutoff),
        ).values(status=SyncStatus.failed, finished_at=datetime.now(UTC),
                 errors=[{"error": "worker stopped mid-run; next run resumes from saved cursors"}]))
        return int(res.rowcount or 0)


__all__ = ["SyncService", "enqueue", "fail_stale_runs", "queue_or_run", "run_to_dict"]

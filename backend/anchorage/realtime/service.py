"""Real-time seam: EventSource protocol, index lifecycle, detector, simulator.

Real-time collection is out of scope for Level 1; `NullEventSource` is the production default and
`SimulatorEventSource` (ENABLE_SIMULATOR=true, dev only) produces clearly-labelled synthetic events.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.core.bus import CONTROL, EVENTS, get_bus
from anchorage.core.config import get_settings
from anchorage.core.db import session_scope, sessionmaker
from anchorage.ioc.normalize import Normalized, Rejected, guess, normalize, refang
from anchorage.models import Detection, Ioc, Rule
from anchorage.models.enums import SEVERITY_RANK, VERDICT_RANK, Severity, Verdict
from anchorage.realtime.index import IocEntry, MatcherIndex, RuleEntry
from anchorage.rules.allowlist import active_entries, python_any
from anchorage.rules.compile import EvalContext, compile_python, ioc_view
from anchorage.rules.engine import rule_is_live
from anchorage.rules.schema import ConditionError, parse_condition

log = logging.getLogger("anchorage.realtime")

# Event fields we read observables from. Anything else in an event is ignored and not stored.
OBSERVABLE_FIELDS: dict[str, str | None] = {
    "src_ip": "ip", "dst_ip": "ip", "ip": "ip", "client_ip": "ip", "server_ip": "ip",
    "domain": "domain", "host": "domain", "hostname": "domain", "query": "domain", "sni": "domain",
    "url": "url", "uri": "url", "ja3": "ja3", "ja3s": "ja3s", "asn": "asn", "dst": None, "indicator": None,
}
CONTEXT_FIELDS = ("ts", "timestamp", "sensor", "action", "protocol", "proto", "direction", "user", "device",
                  "event_type", "dst_port", "src_port")
MAX_EVENTS_PER_REQUEST = 1000


class EventSource(Protocol):
    name: str

    def events(self) -> AsyncIterator[list[dict[str, Any]]]: ...


class NullEventSource:
    """Default: real-time collection is not wired yet (Level 2)."""

    name = "none"

    async def events(self) -> AsyncIterator[list[dict[str, Any]]]:
        if False:  # pragma: no cover
            yield []


# ------------------------------------------------------------------ index ---

_index = MatcherIndex()
_lock = asyncio.Lock()


def current_index() -> MatcherIndex:
    return _index


async def rebuild_index(session: AsyncSession | None = None) -> MatcherIndex:
    global _index
    async with _lock:
        t0 = time.perf_counter()
        own = session is None
        s = session or sessionmaker()()
        try:
            idx = MatcherIndex()
            ctx = EvalContext(now=datetime.now(UTC))
            q = select(Ioc).where(Ioc.verdict.is_not(None), Ioc.status == "active", Ioc.allowlisted.is_(False))
            async for ioc in (await s.stream(q.execution_options(yield_per=5000))).scalars():
                idx.add_ioc(IocEntry(ioc.id, ioc.type, ioc.value_norm, ioc.verdict, ioc.severity, ioc.severity_rank,
                                     ioc_view(ioc)))
            now = datetime.now(UTC)
            for r in (await s.execute(select(Rule).where(Rule.deleted_at.is_(None)))).scalars():
                if not rule_is_live(r, now):
                    continue
                try:
                    pred = compile_python(parse_condition(r.condition), ctx)
                except ConditionError:
                    continue
                idx.rules.append(RuleEntry(r.id, r.name, r.version, r.verdict, r.severity,
                                           SEVERITY_RANK[Severity(r.severity)], r.priority, pred))
            idx.allow = python_any(await active_entries(s, now), ctx)
            idx.build_ms = (time.perf_counter() - t0) * 1000
            _index = idx
        finally:
            if own:
                await s.close()
    log.info("matcher index rebuilt: %s", _index.stats())
    return _index


# --------------------------------------------------------------- detector ---

def extract_observables(event: dict[str, Any]) -> list[tuple[str, Normalized]]:
    out: list[tuple[str, Normalized]] = []
    seen: set[tuple[str, str]] = set()
    port = event.get("dst_port")
    for fname, hint in OBSERVABLE_FIELDS.items():
        raw = event.get(fname)
        if raw is None or isinstance(raw, dict | list) or not str(raw).strip():
            continue
        val = refang(str(raw))[:2048]
        n: Normalized | None
        try:
            if hint == "ip":
                n = normalize("ip", val, allow_private=True)
            elif hint == "asn":
                n = normalize("asn", val)
            elif hint:
                n = normalize(hint, val, allow_private=True)
            else:
                n = guess(val)
        except Rejected:
            n = guess(val)
        if n is None:
            continue
        cands = [n]
        if hint == "ip" and fname == "dst_ip" and isinstance(port, int) and 0 < port < 65536:
            with contextlib.suppress(Rejected):
                cands.append(normalize("ip:port", f"[{n.value}]:{port}" if n.type == "ipv6" else f"{n.value}:{port}",
                                       allow_private=True))
        for c in cands:
            if (c.type, c.value) not in seen:
                seen.add((c.type, c.value))
                out.append((fname, c))
    return out


def _obs_view(n: Normalized) -> dict[str, Any]:
    return ioc_view({"type": n.type, "value_norm": n.value, "ip": n.ip, "net": n.net, "port": n.port,
                     "asn": n.asn, "host": n.host})


def _sanitize(event: dict[str, Any], observables: list[tuple[str, Normalized]]) -> dict[str, Any]:
    kept: dict[str, Any] = {k: str(event[k])[:200] for k in CONTEXT_FIELDS if k in event and event[k] is not None}
    kept["observables"] = [{"field": f, "type": n.type, "value": n.value} for f, n in observables]
    return kept


def _rank(verdict: str, severity: str) -> tuple[int, int]:
    return SEVERITY_RANK[Severity(severity)], VERDICT_RANK[Verdict(verdict)]


def detect(index: MatcherIndex, event: dict[str, Any]) -> list[dict[str, Any]]:
    """Pure function: event → detection dicts (not persisted)."""
    observables = extract_observables(event)
    results = []
    reported_iocs: set[int] = set()
    reported_rules: set[int] = set()
    for fname, n in observables:
        obs = _obs_view(n)
        if index.allow(obs):
            continue
        hits = index.lookup(n.type, n.value, n.ip, n.host)
        hits = [(e, how) for e, how in hits if not index.allow(e.view)]
        views = [obs] + [e.view for e, _ in hits]
        matched_rules = [r for r in index.rules if any(r.predicate(v) for v in views)]
        # one detection per IOC/rule per event (dst_ip and dst_ip:port often hit the same IOC)
        hits = [(e, how) for e, how in hits if e.id not in reported_iocs]
        if not hits and {r.id for r in matched_rules} <= reported_rules:
            continue
        reported_iocs.update(e.id for e, _ in hits)
        reported_rules.update(r.id for r in matched_rules)
        candidates: list[tuple[tuple[int, int], str, str]] = []
        for e, _ in hits:
            if e.verdict and e.severity:
                candidates.append((_rank(e.verdict, e.severity), e.verdict, e.severity))
        for r in matched_rules:
            candidates.append((_rank(r.verdict, r.severity), r.verdict, r.severity))
        if not candidates:
            continue
        (sev_rank, _), verdict, severity = max(candidates, key=lambda c: c[0])
        top = hits[0] if hits else None
        results.append({
            "observable": n.value, "observable_type": n.type, "field": fname,
            "matched_by": top[1] if top else "rule", "ioc_id": top[0].id if top else None,
            "rule_ids": sorted({r.id for r in matched_rules}), "verdict": verdict, "severity": severity,
            "severity_rank": sev_rank, "event": _sanitize(event, observables),
        })
    return results


async def ingest(events: list[dict[str, Any]], source: str, simulated: bool = False) -> list[Detection]:
    index = current_index()
    now = datetime.now(UTC)
    rows: list[Detection] = []
    for ev in events[:MAX_EVENTS_PER_REQUEST]:
        if not isinstance(ev, dict):
            continue
        ts = None
        for k in ("ts", "timestamp"):
            if ev.get(k):
                from anchorage.sources.base import parse_dt

                ts = parse_dt(ev[k])
                break
        for d in detect(index, ev):
            rows.append(Detection(ts=now, event_ts=ts, source=source[:80], is_simulated=simulated, **{
                k: d[k] for k in ("observable", "observable_type", "matched_by", "ioc_id", "rule_ids", "verdict",
                                  "severity", "severity_rank", "event")}))
    if rows:
        async with session_scope() as s:
            s.add_all(rows)
        bus = get_bus()
        for r in rows[:50]:
            await bus.publish(EVENTS, "detection.created", detection_to_dict(r))
    return rows


def detection_to_dict(d: Detection) -> dict[str, Any]:
    from anchorage.ioc.normalize import defang

    return {"id": d.id, "ts": d.ts, "event_ts": d.event_ts, "source": d.source,
            "observable": defang(d.observable, d.observable_type), "observable_type": d.observable_type,
            "matched_by": d.matched_by, "ioc_id": d.ioc_id, "rule_ids": d.rule_ids or [], "verdict": d.verdict,
            "severity": d.severity, "is_simulated": d.is_simulated, "event": d.event}


# -------------------------------------------------------------- simulator ---

class SimulatorEventSource:
    """DEV ONLY. Emits synthetic network events, ~30 % of which reuse flagged IOC values."""

    name = "simulator"

    def __init__(self, interval: float, seed: int | None = None) -> None:
        self.interval = interval
        self.r = random.Random(seed)

    def _event(self) -> dict[str, Any]:
        idx = current_index()
        known = list(idx.exact.values())
        ev: dict[str, Any] = {"ts": datetime.now(UTC).isoformat(), "sensor": "sim-sensor-01",
                              "src_ip": f"10.20.{self.r.randint(0, 9)}.{self.r.randint(2, 250)}",
                              "protocol": self.r.choice(["tcp", "udp", "dns", "http"]), "event_type": "simulated"}
        if known and self.r.random() < 0.3:
            e = self.r.choice(known)
            if e.type in ("ipv4", "ipv6"):
                ev["dst_ip"] = e.value
            elif e.type == "ip:port":
                ip, _, port = e.value.rpartition(":")
                ev["dst_ip"], ev["dst_port"] = ip.strip("[]"), int(port)
            elif e.type in ("domain", "onion"):
                ev["query"] = self.r.choice(["", "www.", "cdn."]) + e.value
            elif e.type == "url":
                ev["url"] = e.value
            else:
                ev["indicator"] = e.value
        else:
            ev["dst_ip"] = f"{self.r.choice([34, 52, 104, 142, 151, 172])}.{self.r.randint(0, 255)}." \
                           f"{self.r.randint(0, 255)}.{self.r.randint(1, 254)}"
            ev["dst_port"] = self.r.choice([443, 80, 53, 8443, 4444])
        return ev

    async def events(self) -> AsyncIterator[list[dict[str, Any]]]:
        while True:
            await asyncio.sleep(self.interval)
            yield [self._event() for _ in range(self.r.randint(1, 4))]


async def _consume(source: EventSource, simulated: bool) -> None:
    async for batch in source.events():
        try:
            await ingest(batch, source.name, simulated=simulated)
        except Exception:
            log.exception("event batch failed")


async def _index_listener() -> None:
    pending = asyncio.Event()

    async def debounce() -> None:
        while True:
            await pending.wait()
            await asyncio.sleep(1.0)  # coalesce bursts (sync + flags + allowlist)
            pending.clear()
            try:
                await rebuild_index()
                await get_bus().publish(EVENTS, "index.rebuilt", current_index().stats())
            except Exception:
                log.exception("index rebuild failed")

    task = asyncio.create_task(debounce())
    try:
        async for msg in get_bus().subscribe(CONTROL):
            if msg.get("type") == "index.rebuild":
                pending.set()
    finally:
        task.cancel()


async def start_realtime() -> list[asyncio.Task[Any]]:
    try:
        await rebuild_index()
    except Exception:
        log.exception("initial index build failed (will retry on next change)")
    tasks = [asyncio.create_task(_index_listener())]
    s = get_settings()
    if s.enable_simulator:
        log.warning("ENABLE_SIMULATOR=true: generating synthetic events (dev only)")
        tasks.append(asyncio.create_task(_consume(SimulatorEventSource(s.simulator_interval_seconds), True)))
    return tasks

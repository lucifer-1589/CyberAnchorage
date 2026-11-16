"""Overview stats, sync status/history/trigger, audit log, WebSocket fan-out."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import Date, cast, func, select

from anchorage.api.deps import Analyst, SessionDep, Viewer, user_from_token
from anchorage.core.bus import EVENTS, get_bus
from anchorage.core.db import sessionmaker
from anchorage.models import AuditLog, Detection, Ioc, IocFlag, Rule, SourceCursor, SyncRun, WorkerState
from anchorage.models.enums import SyncKind, SyncStatus
from anchorage.sources import build_sources
from anchorage.sync.service import enqueue, run_to_dict

router = APIRouter(tags=["ops"])


# --------------------------------------------------------------- overview ---

@router.get("/stats/overview")
async def overview(_: Viewer, session: SessionDep) -> dict[str, Any]:
    now = datetime.now(UTC)
    active = Ioc.status == "active"

    async def scalar(q: Any) -> int:
        return int(await session.scalar(q) or 0)

    async def grouped(col: Any, *where: Any, limit: int = 20) -> list[dict[str, Any]]:
        q = select(col.label("k"), func.count().label("n")).where(*where).group_by("k").order_by(func.count().desc())
        return [{"key": k, "count": n} for k, n in (await session.execute(q.limit(limit))).all() if k is not None]

    since = (now - timedelta(days=29)).date()
    day = cast(Ioc.created_at, Date)
    ingest = {d: n for d, n in (await session.execute(
        select(day, func.count()).where(Ioc.created_at >= since).group_by(day))).all()}
    fday = cast(IocFlag.ts, Date)
    flags = {d: n for d, n in (await session.execute(
        select(fday, func.count()).where(IocFlag.ts >= since).group_by(fday))).all()}
    timeline = [{"date": (since + timedelta(days=i)).isoformat(),
                 "ingested": ingest.get(since + timedelta(days=i), 0),
                 "flagged": flags.get(since + timedelta(days=i), 0)} for i in range(30)]

    last_runs = (await session.execute(select(SyncRun).where(SyncRun.status != SyncStatus.queued)
                                       .order_by(SyncRun.id.desc()).limit(10))).scalars().all()
    last_ok = next((r for r in last_runs if r.status == SyncStatus.success), None)
    worker = await session.get(WorkerState, "scheduler")
    return {
        "generated_at": now,
        "totals": {
            "active": await scalar(select(func.count()).select_from(Ioc).where(active)),
            "all": await scalar(select(func.count()).select_from(Ioc)),
            "new_24h": await scalar(select(func.count()).select_from(Ioc).where(Ioc.created_at >= now - timedelta(1))),
            "flagged": await scalar(select(func.count()).select_from(Ioc).where(Ioc.verdict.is_not(None))),
            "expired": await scalar(select(func.count()).select_from(Ioc).where(Ioc.status != "active")),
            "allowlisted": await scalar(select(func.count()).select_from(Ioc).where(Ioc.allowlisted.is_(True))),
            "rules_enabled": await scalar(select(func.count()).select_from(Rule).where(
                Rule.enabled.is_(True), Rule.deleted_at.is_(None))),
            "detections_24h": await scalar(select(func.count()).select_from(Detection).where(
                Detection.ts >= now - timedelta(1))),
            "demo": await scalar(select(func.count()).select_from(Ioc).where(Ioc.is_demo.is_(True))),
        },
        "by_type": await grouped(Ioc.type, active),
        "by_source": await grouped(func.unnest(Ioc.sources), active),
        "by_verdict": await grouped(Ioc.verdict, Ioc.verdict.is_not(None)),
        "by_severity": await grouped(Ioc.severity, Ioc.severity.is_not(None)),
        "top_malware": await grouped(func.unnest(Ioc.malware_families), active, limit=8),
        "top_actors": await grouped(func.unnest(Ioc.actors), active, limit=8),
        "timeline": timeline,
        "sync": {
            "last_run": run_to_dict(last_runs[0]) if last_runs else None,
            "last_success_at": last_ok.finished_at if last_ok else None,
            "recent": [{"id": r.id, "status": r.status, "kind": r.kind, "started_at": r.started_at,
                        "new": r.new_count, "updated": r.updated_count} for r in last_runs],
            "worker": worker.value if worker else None,
        },
    }


# ------------------------------------------------------------------- sync ---

def _worker_view(ws: WorkerState | None) -> dict[str, Any]:
    if ws is None:
        return {"alive": False, "heartbeat_at": None, "jobs": {}}
    hb = ws.value.get("heartbeat_at")
    alive = isinstance(hb, str) and datetime.fromisoformat(hb) > datetime.now(UTC) - timedelta(seconds=60)
    return {"alive": alive, "heartbeat_at": hb, "jobs": ws.value.get("jobs", {})}


@router.get("/sync/status")
async def sync_status(_: Viewer, session: SessionDep) -> dict[str, Any]:
    health: list[dict[str, Any]] = []
    for src in build_sources():
        try:
            health.extend(asdict(h) for h in await src.health())
        finally:
            await src.close()
    for h in health:  # don't leak absolute host paths to viewers beyond the file name
        h["path"] = h["path"].replace("\\", "/").split("/")[-1] if h.get("path") else h.get("path")
    cursors = (await session.execute(select(SourceCursor).order_by(SourceCursor.source_key))).scalars().all()
    current = (await session.execute(select(SyncRun).where(SyncRun.status.in_([SyncStatus.queued, SyncStatus.running]))
                                     .order_by(SyncRun.id))).scalars().all()
    return {
        "sources": health,
        "cursors": [{"source_key": c.source_key, "max_rowid": c.max_rowid, "max_last_seen": c.max_last_seen,
                     "updated_at": c.updated_at} for c in cursors],
        "worker": _worker_view(await session.get(WorkerState, "scheduler")),
        "current": [run_to_dict(r) for r in current],
    }


@router.get("/sync/runs")
async def sync_runs(_: Viewer, session: SessionDep, limit: int = Query(50, ge=1, le=200),
                    offset: int = Query(0, ge=0)) -> dict[str, Any]:
    total = await session.scalar(select(func.count()).select_from(SyncRun))
    runs = (await session.execute(select(SyncRun).order_by(SyncRun.id.desc()).limit(limit).offset(offset))).scalars()
    return {"items": [run_to_dict(r) for r in runs], "total": int(total or 0), "limit": limit, "offset": offset}


class SyncIn(BaseModel):
    kind: SyncKind = SyncKind.manual


@router.post("/sync/run", status_code=202)
async def sync_now(body: SyncIn, user: Analyst) -> dict[str, Any]:
    if body.kind == SyncKind.hourly:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "use manual (incremental) or daily (full)")
    return run_to_dict(await enqueue(body.kind.value, user.email))


# ------------------------------------------------------------------ audit ---

@router.get("/audit")
async def audit_log(_: Analyst, session: SessionDep, limit: int = Query(100, ge=1, le=500),
                    offset: int = Query(0, ge=0), entity_type: str | None = None, action: str | None = None,
                    actor: str | None = Query(None, max_length=320)) -> dict[str, Any]:
    q = select(AuditLog)
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    if action:
        q = q.where(AuditLog.action == action)
    if actor:
        q = q.where(AuditLog.actor_email.ilike(f"%{actor.replace('%', '').replace('_', '')}%"))
    total = await session.scalar(select(func.count()).select_from(q.subquery()))
    rows = (await session.execute(q.order_by(AuditLog.id.desc()).limit(limit).offset(offset))).scalars()
    return {"items": [{"id": a.id, "ts": a.ts, "actor_email": a.actor_email, "action": a.action,
                       "entity_type": a.entity_type, "entity_id": a.entity_id, "before": a.before, "after": a.after,
                       "ip": a.ip} for a in rows],
            "total": int(total or 0), "limit": limit, "offset": offset}


# -------------------------------------------------------------- websocket ---

@router.websocket("/ws")
async def ws(websocket: WebSocket, token: str = Query(...)) -> None:
    """Relays bus events (sync progress, new flags, detections) to authenticated clients."""
    try:
        async with sessionmaker()() as session:
            await user_from_token(session, token)
    except HTTPException:
        await websocket.close(code=4401)
        return
    await websocket.accept()

    async def pump() -> None:
        async for msg in get_bus().subscribe(EVENTS):
            await websocket.send_json({"type": msg["type"], "ts": msg["ts"], "data": msg["data"]})

    async def keepalive() -> None:
        while True:
            await asyncio.sleep(25)
            await websocket.send_json({"type": "ping", "ts": datetime.now(UTC).isoformat(), "data": {}})

    tasks = [asyncio.create_task(pump()), asyncio.create_task(keepalive())]
    try:
        while True:
            await websocket.receive_text()  # client messages are ignored; detects disconnect
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

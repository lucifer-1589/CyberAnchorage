"""Worker process: python -m anchorage.worker

* hourly incremental sync at :SYNC_HOURLY_MINUTE
* daily full reconcile at SYNC_DAILY_HOUR_UTC:SYNC_DAILY_MINUTE (default 07:00 UTC, after the CTI's 06:00 batch)
* executes queued manual runs ("Sync now"), woken by Redis or a 5 s poll
* on start-up, catches up: a full reconcile if none succeeded in the last 24 h (the app may have been
  closed at 07:00 UTC), otherwise an incremental run if none succeeded in the last hour
* persists next run times + heartbeat in `worker_state` for the Sync page
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from datetime import UTC, datetime, timedelta
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from anchorage.core.bus import CONTROL, get_bus
from anchorage.core.config import get_settings
from anchorage.core.db import dispose_engine, init_engine, session_scope
from anchorage.models import SyncRun, WorkerState
from anchorage.models.enums import SyncKind, SyncStatus
from anchorage.sync.service import SyncService, fail_stale_runs

log = logging.getLogger("anchorage.worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

POLL_SECONDS = 5


def build_scheduler(service: SyncService) -> AsyncIOScheduler:
    s = get_settings()
    sched = AsyncIOScheduler(timezone=UTC)
    sched.add_job(service.run, CronTrigger(minute=s.sync_hourly_minute, timezone=UTC), args=["hourly"],
                  id="hourly", name="Hourly incremental sync", max_instances=1, coalesce=True,
                  misfire_grace_time=900)
    sched.add_job(service.run, CronTrigger(hour=s.sync_daily_hour_utc, minute=s.sync_daily_minute, timezone=UTC),
                  args=["daily"], id="daily", name="Daily full reconcile", max_instances=1, coalesce=True,
                  misfire_grace_time=3600)
    return sched


async def write_state(sched: AsyncIOScheduler) -> None:
    jobs: dict[str, Any] = {}
    for job in sched.get_jobs():
        jobs[job.id] = {"name": job.name,
                        "next_run_at": job.next_run_time.isoformat() if job.next_run_time else None}
    value = {"heartbeat_at": datetime.now(UTC).isoformat(), "jobs": jobs}
    async with session_scope() as s:
        stmt = pg_insert(WorkerState).values(key="scheduler", value=value, updated_at=datetime.now(UTC))
        await s.execute(stmt.on_conflict_do_update(index_elements=[WorkerState.key],
                                                   set_={"value": stmt.excluded.value,
                                                         "updated_at": stmt.excluded.updated_at}))


async def run_queued(service: SyncService) -> None:
    async with session_scope() as s:
        run = (await s.execute(select(SyncRun).where(SyncRun.status == SyncStatus.queued)
                               .order_by(SyncRun.id).limit(1))).scalar_one_or_none()
    if run is not None:
        log.info("running queued sync %s (%s)", run.id, run.kind)
        await service.run(run.kind, run.triggered_by, run_id=run.id)


async def catch_up_kind(now: datetime | None = None) -> str | None:
    """Which run (if any) is overdue: "daily" when no full reconcile succeeded in 24 h, else "hourly" when no
    run succeeded in the last hour, else None."""
    now = now or datetime.now(UTC)
    ok = SyncRun.status.in_([SyncStatus.success, SyncStatus.partial])
    async with session_scope() as s:
        last_daily = await s.scalar(select(func.max(SyncRun.finished_at)).where(ok, SyncRun.kind == SyncKind.daily))
        last_any = await s.scalar(select(func.max(SyncRun.finished_at)).where(ok))
    if last_daily is None or now - last_daily > timedelta(hours=24):
        return SyncKind.daily
    if last_any is None or now - last_any > timedelta(hours=1):
        return SyncKind.hourly
    return None


async def serve(stop: asyncio.Event | None = None) -> None:
    """Scheduler + queued-run loop. Used by the worker process and by the API's embedded-worker mode."""
    stop = stop or asyncio.Event()
    stale = await fail_stale_runs()
    if stale:
        log.warning("marked %d stale running sync(s) as failed", stale)
    service = SyncService()
    sched = build_scheduler(service)
    overdue = await catch_up_kind()
    if overdue:
        sched.add_job(service.run, args=[overdue], kwargs={"triggered_by": "startup catch-up"}, id="catch-up",
                      name="Start-up catch-up sync", next_run_time=datetime.now(UTC), max_instances=1)
        log.info("start-up catch-up: queued a %s sync", overdue)
    sched.start()
    wake = asyncio.Event()

    async def listen() -> None:
        async for msg in get_bus().subscribe(CONTROL):
            if msg.get("type") == "sync.wake":
                wake.set()

    listener = asyncio.create_task(listen())
    log.info("worker started; jobs: %s", [(j.id, str(j.next_run_time)) for j in sched.get_jobs()])
    try:
        while not stop.is_set():
            await write_state(sched)
            try:
                await run_queued(service)
            except Exception:
                log.exception("queued run failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake.wait(), timeout=POLL_SECONDS)
            wake.clear()
    finally:
        listener.cancel()
        sched.shutdown(wait=False)


async def main() -> None:
    init_engine()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # Windows
            loop.add_signal_handler(sig, stop.set)
    try:
        await serve(stop)
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())

"""API process startup/shutdown hooks."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import FastAPI

from anchorage.core.bus import get_bus
from anchorage.core.db import dispose_engine, init_engine

log = logging.getLogger("anchorage.api")


async def startup(app: FastAPI) -> None:
    init_engine()
    app.state.tasks = []
    try:
        from anchorage.realtime.service import start_realtime

        app.state.tasks.extend(await start_realtime())
    except ImportError:
        pass
    from anchorage.core.config import get_settings

    if get_settings().embedded_worker:
        from anchorage.worker import serve

        app.state.tasks.append(asyncio.create_task(serve()))
        log.info("embedded worker started (hourly + daily 07:00 UTC syncs run in this process)")
    log.info("CyberAnchorage API started")


async def shutdown(app: FastAPI) -> None:
    for task in getattr(app.state, "tasks", []):
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
    await get_bus().close()
    await dispose_engine()

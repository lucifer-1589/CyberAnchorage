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
    log.info("CyberAnchorage API started")


async def shutdown(app: FastAPI) -> None:
    for task in getattr(app.state, "tasks", []):
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
    await get_bus().close()
    await dispose_engine()

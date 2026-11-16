"""Event bus: Redis pub/sub in docker, in-process fallback for single-process dev/tests.

Channels:
  anchorage:events   UI-facing events relayed to WebSocket clients
  anchorage:control  internal signals (index.rebuild, sync.wake)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, Protocol

log = logging.getLogger(__name__)

EVENTS = "anchorage:events"
CONTROL = "anchorage:control"


class Bus(Protocol):
    async def publish(self, channel: str, type_: str, data: dict[str, Any] | None = None) -> None: ...
    def subscribe(self, *channels: str) -> AsyncIterator[dict[str, Any]]: ...
    async def close(self) -> None: ...


def _envelope(channel: str, type_: str, data: dict[str, Any] | None) -> dict[str, Any]:
    return {"channel": channel, "type": type_, "ts": datetime.now(UTC).isoformat(), "data": data or {}}


class MemoryBus:
    def __init__(self) -> None:
        self._subs: list[tuple[set[str], asyncio.Queue[dict[str, Any]]]] = []

    async def publish(self, channel: str, type_: str, data: dict[str, Any] | None = None) -> None:
        msg = _envelope(channel, type_, data)
        for chans, q in list(self._subs):
            if channel in chans:
                q.put_nowait(msg)

    async def subscribe(self, *channels: str) -> AsyncIterator[dict[str, Any]]:  # type: ignore[override]
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        entry = (set(channels), q)
        self._subs.append(entry)
        try:
            while True:
                yield await q.get()
        finally:
            self._subs.remove(entry)

    async def close(self) -> None:
        self._subs.clear()


class RedisBus:
    def __init__(self, url: str) -> None:
        import redis.asyncio as redis

        self._redis = redis.from_url(url, decode_responses=True)

    async def publish(self, channel: str, type_: str, data: dict[str, Any] | None = None) -> None:
        try:
            await self._redis.publish(channel, json.dumps(_envelope(channel, type_, data), default=str))
        except Exception as exc:  # bus failures must never break a sync/rule save
            log.warning("bus publish failed: %s", exc)

    async def subscribe(self, *channels: str) -> AsyncIterator[dict[str, Any]]:  # type: ignore[override]
        while True:
            pubsub = self._redis.pubsub()
            try:
                await pubsub.subscribe(*channels)
                async for raw in pubsub.listen():
                    if raw.get("type") != "message":
                        continue
                    try:
                        yield json.loads(raw["data"])
                    except (ValueError, TypeError):
                        continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("bus subscribe error, retrying: %s", exc)
                await asyncio.sleep(2)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.aclose()

    async def close(self) -> None:
        await self._redis.aclose()


_bus: Bus | None = None


def get_bus() -> Bus:
    global _bus
    if _bus is None:
        from anchorage.core.config import get_settings

        url = get_settings().redis_url
        _bus = RedisBus(url) if url else MemoryBus()
    return _bus


def set_bus(bus: Bus | None) -> None:
    global _bus
    _bus = bus

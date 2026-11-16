"""Real-data mode: purging demo data, and the worker's start-up catch-up sync."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from anchorage.cli import purge_demo
from anchorage.core.config import get_settings
from anchorage.core.db import session_scope
from anchorage.demo.fixture import generate_fixture
from anchorage.models import AuditLog, Detection, Ioc, Rule, SourceCursor, SourceRowState, SyncRun
from anchorage.sync.service import SyncService
from anchorage.worker import catch_up_kind
from tests.integration.test_sync import _mini_cti


async def _count(model: type, *where: object) -> int:
    async with session_scope() as s:
        return int(await s.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def test_purge_demo_leaves_only_real_cti_data(db: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real = _mini_cti(tmp_path / "cti")
    demo = tmp_path / "demo-cti"
    s = get_settings()
    monkeypatch.setattr(s, "cti_data_dir", str(real))
    monkeypatch.setattr(s, "demo_cti_dir", str(demo))
    monkeypatch.setattr(s, "demo_data_enabled", True)

    # what the real CTI alone produces
    await SyncService().run("daily", triggered_by="test")
    async with session_scope() as sess:
        real_values = set((await sess.execute(select(Ioc.type, Ioc.value_norm))).all())
        await sess.execute(Ioc.__table__.delete())
        await sess.execute(SourceCursor.__table__.delete())
        await sess.execute(SourceRowState.__table__.delete())

    generate_fixture(demo, count=80)
    # demo + real mixed, plus a simulated detection and a demo rule
    await SyncService().run("manual", triggered_by="test")
    async with session_scope() as sess:
        sess.add(Rule(name="sample", verdict="suspicious", severity="low", is_demo=True,
                      condition={"field": "type", "operator": "eq", "value": "domain"}))
        sess.add(Detection(source="simulator", event={}, observable="x", observable_type="domain",
                           matched_by="exact", verdict="malicious", severity="high", is_simulated=True))
    assert await _count(Ioc, Ioc.is_demo.is_(True)) > 0

    await purge_demo()

    assert await _count(Ioc, Ioc.is_demo.is_(True)) == 0
    assert await _count(Ioc, Ioc.sources.any("demo:crawler")) == 0  # type: ignore[arg-type]
    assert await _count(Detection, Detection.is_simulated.is_(True)) == 0
    assert await _count(Rule, Rule.is_demo.is_(True)) == 0
    assert await _count(Rule, Rule.name == "sample") == 1  # kept as a starter rule
    assert await _count(AuditLog, AuditLog.action == "data.purge_demo") == 1
    assert not demo.exists()
    async with session_scope() as sess:
        assert set((await sess.execute(select(Ioc.type, Ioc.value_norm))).all()) == real_values
        assert all(not src.startswith("demo:") for row in (await sess.execute(select(Ioc.sources))).scalars()
                   for src in row)

    runs = await _count(SyncRun)
    await purge_demo(if_present=True)  # nothing left to purge: a no-op, no new sync
    assert await _count(SyncRun) == runs


async def test_catch_up_kind(db: None) -> None:
    now = datetime.now(UTC)
    assert await catch_up_kind(now) == "daily"  # nothing ever ran

    async with session_scope() as s:
        s.add(SyncRun(kind="daily", mode="full", status="success", finished_at=now - timedelta(hours=3)))
    assert await catch_up_kind(now) == "hourly"  # daily is fresh, but nothing in the last hour

    async with session_scope() as s:
        s.add(SyncRun(kind="hourly", mode="incremental", status="success", finished_at=now - timedelta(minutes=10)))
    assert await catch_up_kind(now) is None

    async with session_scope() as s:
        s.add(SyncRun(kind="hourly", mode="incremental", status="failed", finished_at=now))
    assert await catch_up_kind(now + timedelta(hours=25)) == "daily"  # failures don't count

"""Sync: idempotency, incremental pickup of changed CTI rows, daily reconcile/aging, locking, scheduler."""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select, text, update

from anchorage.core.db import session_scope
from anchorage.demo.fixture import CRAWLER_DDL, TELEGRAM_DDL, generate_fixture
from anchorage.models import Ioc, SyncRun
from anchorage.sources.sqlite_source import SqliteSnapshotSource
from anchorage.sync.service import ADVISORY_LOCK_KEY, SyncService, enqueue


def _service(root: Path, batch_size: int = 50) -> SyncService:
    return SyncService(lambda: [SqliteSnapshotSource(root, name="t")], batch_size=batch_size)


def _now(delta_days: float = 0) -> str:
    return (datetime.now(UTC) - timedelta(days=delta_days)).strftime("%Y-%m-%d %H:%M:%S")


def _mini_cti(root: Path) -> Path:
    (root / "darkweb_intel").mkdir(parents=True)
    (root / "telegram-scraper" / "database").mkdir(parents=True)
    con = sqlite3.connect(root / "darkweb_intel" / "crawler.db")
    con.executescript(CRAWLER_DDL)
    rows = [
        ("ip_address", "45.9.148.10", "HIGH", "AMBER", _now(5), _now(1), "c2", 80),
        ("domain", "evil-cdn[.]top", "MEDIUM", "WHITE", _now(10), _now(2), "phishing", 50),
        ("url", "hxxp://evil-cdn[.]top/gate.php", "LOW", "GREEN", _now(3), _now(3), "", 30),
        ("ipv4", "10.0.0.5", "HIGH", "WHITE", _now(1), _now(1), "", 90),  # private → rejected
        ("md5", "c8f089ff85f33c07c0334862d5211cd4", "LOW", "WHITE", _now(1), _now(1), "", 10),  # out of scope
        ("credential", "user:pass", "LOW", "WHITE", _now(1), _now(1), "", 10),  # PII → dropped
        ("ip_address", "185.220.101.7", "MEDIUM", "WHITE", _now(60), _now(45), "tor", 40),  # >30d → expired
    ]
    con.executemany("INSERT INTO iocs (ioc_type, value, confidence, tlp, first_seen, last_seen, tags, score,"
                    " context) VALUES (?,?,?,?,?,?,?,?, 'RAW PAGE TEXT MUST NOT BE COPIED')", rows)
    con.commit()
    con.close()
    con = sqlite3.connect(root / "telegram-scraper" / "database" / "intel_iocs.db")
    con.executescript(TELEGRAM_DDL)
    con.execute("INSERT INTO iocs (ioc_type, ioc_value, confidence, first_seen, last_seen, severity, categories,"
                " malware_fams) VALUES ('domain', 'EVIL-CDN.top', 'high', ?, ?, 'CRITICAL', 'RANSOMWARE', 'LockBit')",
                (_now(20), _now(0.5)))
    con.execute("INSERT INTO iocs (ioc_type, ioc_value, first_seen, last_seen, severity) VALUES "
                "('cidr', '85.236.147.162/29', ?, ?, 'HIGH')", (_now(2), _now(2)))
    con.commit()
    con.close()
    return root


async def _count() -> int:
    async with session_scope() as s:
        return int(await s.scalar(select(func.count()).select_from(Ioc)) or 0)


async def _get(t: str, v: str) -> Ioc:
    async with session_scope() as s:
        return (await s.execute(select(Ioc).where(Ioc.type == t, Ioc.value_norm == v))).scalar_one()


async def test_first_sync_counts_merge_and_no_raw_content(db: None, tmp_path: Path) -> None:
    root = _mini_cti(tmp_path / "cti")
    run = await _service(root).run("manual")
    assert run.status == "success", run.errors
    # 45.9.148.10, evil-cdn.top (crawler+telegram merged), url, 185.220.101.7, cidr
    assert run.new_count == 5
    assert run.rejected_count == 1
    assert run.skipped_count >= 2  # md5 + credential
    assert await _count() == 5

    dom = await _get("domain", "evil-cdn.top")
    assert sorted(dom.sources) == ["crawler", "telegram"]
    assert dom.tlp == "AMBER"  # WHITE(crawler) vs default AMBER(telegram) → strictest
    assert dom.score == 0.9  # telegram CRITICAL beats crawler 50/100
    assert "LockBit" in dom.malware_families
    assert {"phishing", "ransomware"} <= set(dom.tags)
    assert dom.host_rev == "top.evil-cdn."
    cidr = await _get("cidr", "85.236.147.160/29")
    assert str(cidr.net) == "85.236.147.160/29"
    async with session_scope() as s:
        dump = str((await s.execute(text("SELECT json_agg(i) FROM iocs i"))).scalar())
    assert "RAW PAGE TEXT" not in dump
    assert "user:pass" not in dump


async def test_sync_twice_creates_no_duplicates(db: None, tmp_path: Path) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=400)
    svc = _service(root, batch_size=97)
    first = await svc.run("manual")
    n1 = await _count()
    assert first.new_count == n1 > 100
    second = await svc.run("manual")
    assert (second.new_count, second.updated_count) == (0, 0)
    assert await _count() == n1
    third = await svc.run("daily")  # full re-merge of everything is also a no-op
    assert (third.new_count, third.updated_count) == (0, 0)
    assert await _count() == n1
    async with session_scope() as s:
        dups = await s.scalar(text("SELECT count(*) FROM (SELECT type, value_norm FROM iocs "
                                   "GROUP BY 1, 2 HAVING count(*) > 1) d"))
    assert dups == 0


async def test_changed_cti_row_appears_within_one_hourly_cycle(db: None, tmp_path: Path) -> None:
    root = _mini_cti(tmp_path / "cti")
    svc = _service(root)
    await svc.run("hourly")
    before = await _get("ipv4", "45.9.148.10")
    assert "ransomware" not in before.tags

    con = sqlite3.connect(root / "darkweb_intel" / "crawler.db")
    con.execute("UPDATE iocs SET last_seen = ?, tags = 'c2,ransomware', tlp = 'RED', score = 95 "
                "WHERE value = '45.9.148.10'", (_now(0),))
    con.execute("INSERT INTO iocs (ioc_type, value, first_seen, last_seen) VALUES ('domain', 'brand-new.xyz', ?, ?)",
                (_now(0), _now(0)))
    con.commit()
    con.close()

    run = await svc.run("hourly")
    assert run.mode == "incremental"
    assert run.new_count == 1 and run.updated_count == 1, run.stats
    after = await _get("ipv4", "45.9.148.10")
    assert "ransomware" in after.tags and after.tlp == "RED" and after.score == 0.95
    assert after.last_seen > before.last_seen
    await _get("domain", "brand-new.xyz")


async def test_daily_reconcile_retires_and_ages(db: None, tmp_path: Path) -> None:
    root = _mini_cti(tmp_path / "cti")
    svc = _service(root)
    await svc.run("manual")
    old = await _get("ipv4", "185.220.101.7")
    assert old.status == "expired"  # 45 days old IP > 30 d expiry, set at upsert time

    async with session_scope() as s:  # simulate time passing for an active IOC
        await s.execute(update(Ioc).where(Ioc.value_norm == "45.9.148.10")
                        .values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    con = sqlite3.connect(root / "darkweb_intel" / "crawler.db")
    con.execute("DELETE FROM iocs WHERE value LIKE 'hxxp://evil-cdn%'")
    con.commit()
    con.close()

    run = await svc.run("daily")
    assert run.mode == "full"
    assert (await _get("url", "http://evil-cdn.top/gate.php")).status == "retired"
    assert (await _get("ipv4", "45.9.148.10")).status == "expired"
    assert run.expired_count >= 2
    # the domain lost nothing: still referenced by crawler + telegram
    assert (await _get("domain", "evil-cdn.top")).status == "active"


async def test_only_one_run_at_a_time(db: None, tmp_path: Path, engine) -> None:  # type: ignore[no-untyped-def]
    root = _mini_cti(tmp_path / "cti")
    async with engine.connect() as conn:
        await conn.execute(select(func.pg_advisory_lock(ADVISORY_LOCK_KEY)))
        run = await _service(root).run("hourly")
        assert run.status == "skipped"
        await conn.execute(select(func.pg_advisory_unlock(ADVISORY_LOCK_KEY)))
        await conn.commit()
    assert await _count() == 0
    ok = await _service(root).run("hourly")
    assert ok.status == "success"


async def test_concurrent_runs_do_not_duplicate(db: None, tmp_path: Path) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=300)
    a, b = await asyncio.gather(_service(root).run("manual"), _service(root).run("manual"))
    assert sorted([a.status, b.status]) in (["skipped", "success"], ["success", "success"])
    async with session_scope() as s:
        dups = await s.scalar(text("SELECT count(*) - count(DISTINCT (type, value_norm)) FROM iocs"))
    assert dups == 0


async def test_manual_queue_and_worker_pickup(db: None, tmp_path: Path) -> None:
    from anchorage import worker

    root = _mini_cti(tmp_path / "cti")
    queued = await enqueue("manual", "analyst@x")
    again = await enqueue("manual", "analyst@x")
    assert again.id == queued.id  # no double queueing
    await worker.run_queued(_service(root))
    async with session_scope() as s:
        run = await s.get(SyncRun, queued.id)
    assert run is not None and run.status == "success" and run.new_count == 5


def test_scheduler_jobs() -> None:
    from anchorage.worker import build_scheduler

    sched = build_scheduler(SyncService(lambda: []))
    jobs = {j.id: j for j in sched.get_jobs()}
    assert set(jobs) == {"hourly", "daily"}
    daily = str(jobs["daily"].trigger)
    hourly = str(jobs["hourly"].trigger)
    assert "hour='7'" in daily and "minute='0'" in daily
    assert "minute='5'" in hourly and "hour" not in hourly

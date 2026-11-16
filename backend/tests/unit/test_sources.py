import hashlib
import sqlite3
from pathlib import Path

import httpx
import pytest

from anchorage.demo.fixture import generate_fixture
from anchorage.sources.http_source import HttpSource, _guard
from anchorage.sources.sqlite_source import SqliteSnapshotSource


def _digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


async def test_snapshot_reads_and_never_writes(tmp_path: Path) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=200)
    files = sorted(root.rglob("*.db"))
    before = {f: (_digest(f), f.stat().st_mtime_ns) for f in files}
    listing_before = sorted(p for p in root.rglob("*"))

    src = SqliteSnapshotSource(root, name="t")
    tables = await src.prepare()
    assert {t.store for t in tables} == {"crawler", "connector", "ioc_hunter", "telegram"}
    seen_types = set()
    for t in tables:
        rows = await src.fetch(t, 0, 10_000, None)
        for r in rows:
            seen_types.add(r.raw.ioc_type)
            # raw content columns are never carried
            assert "context" not in r.raw.ref
            for m in r.raw.ref.get("messages", []):
                assert set(m) <= {"channel", "message_id", "date"}
        assert await src.skipped_count(t) >= 0
    assert "ssn_like" not in seen_types  # PII never even read
    assert src.enrichment()  # core.db apts dictionary loaded
    await src.close()

    after = {f: (_digest(f), f.stat().st_mtime_ns) for f in files}
    assert before == after
    assert sorted(p for p in root.rglob("*")) == listing_before  # no journal/-shm/-wal left behind


async def test_cursor_filters_to_new_and_bumped_rows(tmp_path: Path) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=100)
    from anchorage.sources.base import Cursor

    db = root / "darkweb_intel" / "crawler.db"
    con = sqlite3.connect(db)
    max_id, max_ls = con.execute("SELECT max(rowid), max(last_seen) FROM iocs").fetchone()
    con.execute("UPDATE iocs SET last_seen = '2999-01-01 00:00:00' WHERE id = 1")
    con.commit()
    con.close()
    src = SqliteSnapshotSource(root)
    tables = {t.store: t for t in await src.prepare()}
    rows = await src.fetch(tables["crawler"], 0, 1000, Cursor(max_id, max_ls))
    await src.close()
    assert [r.raw.row_key for r in rows if r.raw.row_key == "1"] == ["1"]
    assert all(r.rowid > max_id or (r.last_seen_raw or "") >= max_ls for r in rows)


def test_fixture_refuses_real_cti_dir(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        generate_fixture(tmp_path / "cti" / "demo", forbid_inside=tmp_path / "cti")


async def test_http_source_only_calls_iocs_route() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        assert request.headers["Authorization"] == "Bearer tok"
        return httpx.Response(200, json={"iocs": [{"id": 1, "ioc_type": "domain", "value": "evil.com",
                                                   "origin": "crawler", "score": 80}], "total": 1})

    src = HttpSource("http://cti.local", "tok", transport=httpx.MockTransport(handler))
    (table,) = await src.prepare()
    rows = await src.fetch(table, 0, 100, None)
    assert rows[0].raw.value == "evil.com" and rows[0].raw.score == 0.8
    await src.close()
    assert calls == ["/api/iocs"]
    with pytest.raises(PermissionError):
        _guard("/api/tg-pty/exec")

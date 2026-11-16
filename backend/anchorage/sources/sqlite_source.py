"""SqliteSnapshotSource — the default adapter (snapshot, then read the snapshot read-only)."""

from __future__ import annotations

import asyncio
import logging
import shutil
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from anchorage.core.config import DEFAULT_CTI_STORES
from anchorage.sources.base import Cursor, SourceHealth, SourceRow, TableHandle
from anchorage.sources.readers import READERS, count_out_of_scope, load_apt_dictionary
from anchorage.sources.snapshot import has_table, open_snapshot, snapshot_sqlite

log = logging.getLogger(__name__)


class SqliteSnapshotSource:
    def __init__(self, root: str | Path, *, name: str = "cti", prefix: str = "", is_demo: bool = False,
                 stores: dict[str, str] | None = None) -> None:
        self.root = Path(root)
        self.name = name
        self.prefix = prefix
        self.is_demo = is_demo
        self.stores = stores or DEFAULT_CTI_STORES
        self._tmp: Path | None = None
        self._cons: dict[str, sqlite3.Connection] = {}
        self.errors: list[dict[str, str]] = []

    def _path(self, store: str) -> Path:
        return self.root / self.stores[store]

    async def prepare(self) -> list[TableHandle]:
        return await asyncio.to_thread(self._prepare_sync)

    def _prepare_sync(self) -> list[TableHandle]:
        self._tmp = Path(tempfile.mkdtemp(prefix=f"anchorage-{self.name}-"))
        handles: list[TableHandle] = []
        for store in [*READERS, "core"]:
            path = self._path(store)
            if not path.exists():
                continue
            try:
                snap = snapshot_sqlite(path, self._tmp / store)
                con = open_snapshot(snap)
                self._cons[store] = con
            except (sqlite3.Error, OSError) as exc:
                self.errors.append({"source": self.name, "store": store, "error": f"snapshot failed: {exc}"})
                log.exception("snapshot of %s failed", path)
                continue
            if store in READERS and has_table(con, READERS[store][0].table):
                spec = READERS[store][0]
                handles.append(TableHandle(source=f"{self.prefix}{store}", store=store, table=spec.table,
                                           supports_cursor=spec.last_seen_col is not None))
        return handles

    def enrichment(self) -> dict[str, dict[str, list[str]]]:
        con = self._cons.get("core")
        return load_apt_dictionary(con) if con else {}

    async def fetch(self, table: TableHandle, after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
        con = self._cons[table.store]
        reader = READERS[table.store][1]
        return await asyncio.to_thread(reader, con, table.source, self.is_demo, after_rowid, limit, cursor)

    async def skipped_count(self, table: TableHandle) -> int:
        con = self._cons[table.store]
        return await asyncio.to_thread(count_out_of_scope, con, READERS[table.store][0])

    async def health(self) -> list[SourceHealth]:
        return await asyncio.to_thread(self._health_sync)

    def _health_sync(self) -> list[SourceHealth]:
        out = []
        for store in self.stores:
            path = self._path(store)
            if not path.exists():
                out.append(SourceHealth(f"{self.prefix}{store}", store, str(path), False, "not found",
                                        is_demo=self.is_demo))
                continue
            st = path.stat()
            rows = None
            detail = "ok"
            if store in READERS:
                try:
                    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
                    try:
                        rows = int(con.execute(f'SELECT count(*) FROM "{READERS[store][0].table}"').fetchone()[0])
                    finally:
                        con.close()
                except sqlite3.Error as exc:
                    detail = f"unreadable: {exc}"
            else:
                detail = "enrichment"
            out.append(SourceHealth(
                f"{self.prefix}{store}", store, str(path), detail in ("ok", "enrichment"), detail, rows, st.st_size,
                datetime.fromtimestamp(st.st_mtime, UTC).isoformat(), self.is_demo))
        return out

    async def close(self) -> None:
        for con in self._cons.values():
            con.close()
        self._cons.clear()
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)
            self._tmp = None

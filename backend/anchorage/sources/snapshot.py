"""Read-only SQLite snapshots of CTI stores.

The CTI databases are never opened writable and never locked beyond the online-backup step:
  1. open the source with a `mode=ro` URI and copy it with the SQLite backup API into a private file
  2. if that fails (e.g. WAL file on a read-only mount without `-shm`), file-copy `db` + `-wal` into the
     private temp dir and open the copy instead
The snapshot is then opened `mode=ro` for reading.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
from pathlib import Path

log = logging.getLogger(__name__)


def _ro_uri(path: Path) -> str:
    return path.resolve().as_uri() + "?mode=ro"


def snapshot_sqlite(src: Path, dest_dir: Path) -> Path:
    """Create a consistent private copy of `src` inside `dest_dir`; return the copy path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / (src.name + ".snapshot")
    try:
        source = sqlite3.connect(_ro_uri(src), uri=True, timeout=5)
        try:
            target = sqlite3.connect(dest)
            try:
                source.backup(target, pages=4096, sleep=0.01)
            finally:
                target.close()
        finally:
            source.close()
        return dest
    except sqlite3.Error as exc:
        log.warning("backup API failed for %s (%s); falling back to file copy", src, exc)

    fallback_dir = dest_dir / (src.name + ".copy")
    fallback_dir.mkdir(exist_ok=True)
    copy = fallback_dir / src.name
    shutil.copy2(src, copy)
    for suffix in ("-wal",):
        side = src.with_name(src.name + suffix)
        if side.exists():
            shutil.copy2(side, fallback_dir / side.name)
    # Opening the private copy read-write lets SQLite replay the copied WAL; the CTI file is untouched.
    con = sqlite3.connect(copy)
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        ok = con.execute("PRAGMA quick_check").fetchone()[0]
        if ok != "ok":
            raise sqlite3.DatabaseError(f"snapshot copy failed integrity check: {ok}")
    finally:
        con.close()
    return copy


def open_snapshot(path: Path) -> sqlite3.Connection:
    # Private read-only snapshot, accessed sequentially from worker threads (asyncio.to_thread).
    con = sqlite3.connect(_ro_uri(path), uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def table_columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in con.execute(f'PRAGMA table_info("{table}")')}  # table names are internal constants


def has_table(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    return row is not None

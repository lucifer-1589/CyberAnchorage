"""Private snapshots of CTI SQLite stores.

The CTI files are only ever *copied*, never opened by SQLite: even a `mode=ro` connection creates or updates
`-shm` (and empty `-wal`) side files next to a WAL-mode database, which would write into the CTI folder.

  1. copy `db` plus its `-wal` / `-journal` side file (if present) into a private temp dir
  2. if the source changed while copying (size or mtime moved), retry, up to 3 times
  3. open the private copy (read-write, it is ours) so SQLite replays the copied WAL / hot journal,
     checkpoint it and run `quick_check`

The snapshot is then opened `mode=ro` for reading. Data still sitting in the CTI's WAL is included.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from pathlib import Path

log = logging.getLogger(__name__)

SIDE_FILES = ("-wal", "-journal")
ATTEMPTS = 3


def _ro_uri(path: Path) -> str:
    return path.resolve().as_uri() + "?mode=ro"


def fingerprint(src: Path) -> tuple[tuple[str, int, int], ...]:
    out = []
    for f in (src, *(src.with_name(src.name + s) for s in SIDE_FILES)):
        if f.exists():
            st = f.stat()
            out.append((f.name, st.st_size, st.st_mtime_ns))
    return tuple(out)


def snapshot_sqlite(src: Path, dest_dir: Path) -> Path:
    """Create a consistent private copy of `src` inside `dest_dir`; return the copy path. Never opens `src`."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        work = dest_dir / f"{src.name}.snap{attempt}"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        copy = work / src.name
        before = fingerprint(src)
        shutil.copyfile(src, copy)
        for suffix in SIDE_FILES:
            side = src.with_name(src.name + suffix)
            if side.exists():
                shutil.copyfile(side, work / side.name)
        if fingerprint(src) != before:
            last_error = RuntimeError("source changed while copying")
            log.info("snapshot of %s raced a CTI write (attempt %d); retrying", src.name, attempt)
            time.sleep(0.2 * attempt)
            continue
        try:
            con = sqlite3.connect(copy)
            try:
                con.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # fold the copied WAL into the private copy
                ok = con.execute("PRAGMA quick_check").fetchone()[0]
            finally:
                con.close()
            if ok != "ok":
                raise sqlite3.DatabaseError(f"integrity check: {ok}")
            return copy
        except sqlite3.Error as exc:
            last_error = exc
            log.warning("snapshot of %s failed (attempt %d): %s", src.name, attempt, exc)
            time.sleep(0.2 * attempt)
    raise sqlite3.DatabaseError(f"could not snapshot {src.name}: {last_error}")


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

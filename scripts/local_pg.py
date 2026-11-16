"""Embedded PostgreSQL 16 for Docker-free local runs (binaries from the `pgserver` wheel).

    python scripts/local_pg.py start   -> starts (or reuses) the server, prints the asyncpg DATABASE_URL
    python scripts/local_pg.py stop    -> fast, clean shutdown
    python scripts/local_pg.py status

Data lives in <repo>/data/pg. The server listens on 127.0.0.1 only (port LOCAL_PG_PORT, default 54329) and
is started *detached* from the console: on Windows, Postgres processes tied to a console crash with
0xC0000142 when that console closes, which corrupts the next start.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pgserver
import psycopg

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "pg"
LOG = ROOT / "data" / "pg.log"
DB = "anchorage"
PORT = int(os.environ.get("LOCAL_PG_PORT", "54329"))
BIN = Path(pgserver.__file__).parent / "pginstall" / "bin"
EXE = ".exe" if os.name == "nt" else ""


def _tool(name: str) -> str:
    return str(BIN / f"{name}{EXE}")


def _detached() -> dict[str, int]:
    if os.name != "nt":
        return {}
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    return {"creationflags": flags}


def running() -> bool:
    return subprocess.run([_tool("pg_ctl"), "-D", str(DATA), "status"], capture_output=True).returncode == 0


def start() -> str:
    if not (DATA / "PG_VERSION").exists():
        DATA.mkdir(parents=True, exist_ok=True)
        subprocess.run([_tool("initdb"), "-D", str(DATA), "-U", "postgres", "--auth=trust", "-E", "UTF8"],
                       check=True, capture_output=True)
    if not running():
        stale = DATA / "postmaster.pid"
        if stale.exists():  # left behind by a crash; pg_ctl already confirmed nothing is running
            stale.unlink()
        subprocess.run(
            [_tool("pg_ctl"), "-D", str(DATA), "-l", str(LOG), "-w", "-t", "60",
             "-o", f"-h 127.0.0.1 -p {PORT}", "start"],
            # never PIPE here: the detached postmaster inherits the handle and pg_ctl would never return
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **_detached(),
        )
    admin = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
    with psycopg.connect(admin, autocommit=True, connect_timeout=10) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB,)).fetchone():
            conn.execute(f'CREATE DATABASE "{DB}"')
    return f"postgresql+asyncpg://postgres@127.0.0.1:{PORT}/{DB}"


def stop() -> None:
    if running():
        subprocess.run([_tool("pg_ctl"), "-D", str(DATA), "-m", "fast", "-w", "stop"], capture_output=True)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    try:
        if cmd == "start":
            print(start())
        elif cmd == "stop":
            stop()
            print("stopped")
        elif cmd == "status":
            print("running" if running() else "stopped")
        else:
            raise SystemExit(f"unknown command {cmd!r}")
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: PostgreSQL command failed ({exc.cmd[0]} exit {exc.returncode}). See {LOG}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: embedded PostgreSQL unavailable: {exc}. See {LOG}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

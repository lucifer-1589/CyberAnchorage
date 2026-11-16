"""Test fixtures.

Integration tests need PostgreSQL 16. Resolution order:
  1. TEST_DATABASE_URL (e.g. the docker-compose postgres)
  2. an embedded server started via the `pgserver` wheel (dev machines without docker)
  3. otherwise integration tests are skipped
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 40)
os.environ.setdefault("REDIS_URL", "")
os.environ.setdefault("DEMO_DATA_ENABLED", "false")
os.environ.setdefault("CTI_SOURCE_MODE", "none")

BACKEND = Path(__file__).resolve().parents[1]
_server = None


def _to_async(url: str) -> str:
    return url.replace("postgresql://", "postgresql+asyncpg://", 1).replace("postgres://", "postgresql+asyncpg://", 1)


def _start_embedded() -> str | None:
    global _server
    try:
        import pgserver
    except ImportError:
        return None
    data_dir = Path(tempfile.gettempdir()) / "anchorage-test-pg"
    _server = pgserver.get_server(str(data_dir), cleanup_mode="stop")
    return str(_server.get_uri())


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        try:
            url = _start_embedded()
        except Exception as exc:  # pragma: no cover - environment specific
            pytest.skip(f"embedded postgres unavailable: {exc}")
    if not url:
        pytest.skip("no TEST_DATABASE_URL and pgserver not installed")

    import psycopg

    admin_url = url
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS anchorage_test WITH (FORCE)")
        conn.execute("CREATE DATABASE anchorage_test")
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(admin_url)
    test_url = urlunsplit(parts._replace(path="/anchorage_test"))
    async_url = _to_async(test_url)

    from alembic import command
    from alembic.config import Config

    os.environ["DATABASE_URL"] = async_url
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")
    yield async_url


@pytest_asyncio.fixture(scope="session")
async def engine(pg_url: str) -> AsyncIterator[object]:
    from anchorage.core.bus import MemoryBus, set_bus
    from anchorage.core.db import dispose_engine, init_engine

    set_bus(MemoryBus())
    eng = init_engine(pg_url)
    yield eng
    await dispose_engine()


TABLES = (
    "detections, ioc_flags, rule_versions, rules, allowlist, iocs, sync_runs, source_cursors, "
    "source_row_state, worker_state, saved_views, refresh_tokens, audit_log, app_settings, users"
)


@pytest_asyncio.fixture
async def db(engine) -> AsyncIterator[None]:  # type: ignore[no-untyped-def]
    async with engine.begin() as conn:  # type: ignore[attr-defined]
        await conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    from anchorage.api import auth

    auth.login_ip_limiter.reset()
    auth.login_email_limiter.reset()
    auth.refresh_limiter.reset()
    yield None


@pytest_asyncio.fixture
async def session(db):  # type: ignore[no-untyped-def]
    from anchorage.core.db import sessionmaker

    async with sessionmaker()() as s:
        yield s


@pytest_asyncio.fixture
async def client(db) -> AsyncIterator[AsyncClient]:  # type: ignore[no-untyped-def]
    from anchorage.main import create_app

    app = create_app(with_lifespan=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def make_user(email: str, role: str, password: str = "correct-horse-battery") -> None:
    from anchorage.core.db import session_scope
    from anchorage.core.security import hash_password
    from anchorage.models import User

    async with session_scope() as s:
        s.add(User(email=email, name=role.title(), role=role, password_hash=hash_password(password)))


async def login(client: AsyncClient, email: str, password: str = "correct-horse-battery") -> dict[str, str]:
    r = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest_asyncio.fixture
async def users(db) -> dict[str, str]:  # type: ignore[no-untyped-def]
    for role in ("admin", "analyst", "viewer"):
        await make_user(f"{role}@anchorage.local", role)
    return {r: f"{r}@anchorage.local" for r in ("admin", "analyst", "viewer")}


@pytest_asyncio.fixture
async def auth_headers(client: AsyncClient, users: dict[str, str]) -> dict[str, dict[str, str]]:
    return {role: await login(client, email) for role, email in users.items()}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Run every async test on the session loop (the engine/pool is session-scoped)."""
    marker = pytest.mark.asyncio(loop_scope="session")
    for item in items:
        if pytest_asyncio.is_async_test(item):
            item.add_marker(marker, append=False)

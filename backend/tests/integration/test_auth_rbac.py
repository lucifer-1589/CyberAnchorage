from __future__ import annotations

from httpx import AsyncClient
from sqlalchemy import select

from anchorage.core.db import session_scope
from anchorage.models import AuditLog
from tests.conftest import login, make_user


async def test_login_me_and_bad_password(client: AsyncClient, users: dict[str, str]) -> None:
    headers = await login(client, users["analyst"])
    me = await client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["role"] == "analyst"

    bad = await client.post("/api/auth/login", json={"email": users["analyst"], "password": "nope-nope-nope"})
    assert bad.status_code == 401
    unknown = await client.post("/api/auth/login", json={"email": "ghost@x.io", "password": "whatever-123"})
    assert unknown.status_code == 401


async def test_unauthenticated_rejected(client: AsyncClient, db: None) -> None:
    assert (await client.get("/api/auth/me")).status_code == 401
    r = await client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


async def test_rbac_users_admin_only(client: AsyncClient, auth_headers: dict[str, dict[str, str]]) -> None:
    assert (await client.get("/api/users", headers=auth_headers["admin"])).status_code == 200
    assert (await client.get("/api/users", headers=auth_headers["analyst"])).status_code == 403
    assert (await client.get("/api/users", headers=auth_headers["viewer"])).status_code == 403
    body = {"email": "new@anchorage.local", "role": "viewer", "password": "long-enough-pass"}
    assert (await client.post("/api/users", json=body, headers=auth_headers["analyst"])).status_code == 403
    r = await client.post("/api/users", json=body, headers=auth_headers["admin"])
    assert r.status_code == 201
    dup = await client.post("/api/users", json=body, headers=auth_headers["admin"])
    assert dup.status_code == 409


async def test_settings_rbac_and_audit(client: AsyncClient, auth_headers: dict[str, dict[str, str]]) -> None:
    cur = (await client.get("/api/settings", headers=auth_headers["viewer"])).json()
    cur["allow_private_ips"] = True
    assert (await client.put("/api/settings", json=cur, headers=auth_headers["analyst"])).status_code == 403
    assert (await client.put("/api/settings", json=cur, headers=auth_headers["admin"])).status_code == 200
    assert (await client.get("/api/settings", headers=auth_headers["viewer"])).json()["allow_private_ips"] is True
    async with session_scope() as s:
        actions = list((await s.execute(select(AuditLog.action))).scalars())
    assert "settings.update" in actions


async def test_admin_cannot_demote_self(client: AsyncClient, auth_headers: dict[str, dict[str, str]]) -> None:
    me = (await client.get("/api/auth/me", headers=auth_headers["admin"])).json()
    r = await client.patch(f"/api/users/{me['id']}", json={"role": "viewer"}, headers=auth_headers["admin"])
    assert r.status_code == 400


async def test_refresh_rotation_and_reuse_detection(client: AsyncClient, users: dict[str, str]) -> None:
    await login(client, users["viewer"])
    old_cookie = client.cookies.get("anchorage_refresh")
    assert old_cookie
    r1 = await client.post("/api/auth/refresh")
    assert r1.status_code == 200
    new_cookie = client.cookies.get("anchorage_refresh")
    assert new_cookie and new_cookie != old_cookie

    # Replaying the rotated token revokes the family, including the new one.
    client.cookies.set("anchorage_refresh", old_cookie, path="/api/auth")
    assert (await client.post("/api/auth/refresh")).status_code == 401
    client.cookies.set("anchorage_refresh", new_cookie, path="/api/auth")
    assert (await client.post("/api/auth/refresh")).status_code == 401


async def test_login_rate_limited(client: AsyncClient, db: None) -> None:
    await make_user("rl@anchorage.local", "viewer")
    codes = [
        (await client.post("/api/auth/login", json={"email": "rl@anchorage.local", "password": "bad-password"})).status_code
        for _ in range(12)
    ]
    assert 429 in codes


async def test_inactive_user_cannot_login(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                          users: dict[str, str]) -> None:
    lst = (await client.get("/api/users", headers=auth_headers["admin"])).json()
    viewer = next(u for u in lst if u["email"] == users["viewer"])
    await client.patch(f"/api/users/{viewer['id']}", json={"is_active": False}, headers=auth_headers["admin"])
    # existing access token is rejected too
    assert (await client.get("/api/auth/me", headers=auth_headers["viewer"])).status_code == 401
    r = await client.post("/api/auth/login", json={"email": users["viewer"], "password": "correct-horse-battery"})
    assert r.status_code == 401

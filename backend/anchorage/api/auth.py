"""Authentication: login, rotating refresh tokens (HttpOnly cookie), logout, me."""

from __future__ import annotations

from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from anchorage.api.deps import SessionDep, Viewer, client_ip
from anchorage.api.types import Email
from anchorage.core.audit import audit
from anchorage.core.config import get_settings
from anchorage.core.ratelimit import SlidingWindowLimiter
from anchorage.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    dummy_verify,
    hash_password,
    needs_rehash,
    verify_password,
)
from anchorage.models import RefreshToken, User

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "anchorage_refresh"
login_ip_limiter = SlidingWindowLimiter(get_settings().login_rate_per_minute)
login_email_limiter = SlidingWindowLimiter(get_settings().login_rate_per_minute)
refresh_limiter = SlidingWindowLimiter(60)


class LoginIn(BaseModel):
    email: Email
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    is_active: bool
    last_login_at: datetime | None = None

    model_config = {"from_attributes": True}


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105
    expires_in: int
    user: UserOut


def _set_refresh_cookie(response: Response, token: str, expires: datetime) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        httponly=True,
        secure=get_settings().is_production,
        samesite="strict",
        path="/api/auth",
        expires=expires,
    )


async def _issue(session: SessionDep, response: Response, user: User, family: str | None = None) -> TokenOut:
    token, jti, fam, exp = create_refresh_token(user.id, family)
    session.add(RefreshToken(jti=jti, family=fam, user_id=user.id, expires_at=exp))
    _set_refresh_cookie(response, token, exp)
    return TokenOut(
        access_token=create_access_token(user.id, user.role),
        expires_in=get_settings().access_token_minutes * 60,
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, request: Request, response: Response, session: SessionDep) -> TokenOut:
    ip = client_ip(request)
    email = body.email.lower()
    if not login_ip_limiter.hit(f"ip:{ip}") or not login_email_limiter.hit(f"em:{email}"):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many login attempts, try again shortly",
            {"Retry-After": str(login_ip_limiter.retry_after(f"ip:{ip}") or 60)},
        )
    user = (await session.execute(select(User).where(func.lower(User.email) == email))).scalar_one_or_none()
    if user is None:
        dummy_verify()
    if user is None or not user.is_active or not verify_password(user.password_hash, body.password):
        await audit(session, None, "auth.login_failed", "user", None, after={"email": email}, ip=ip)
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    user.last_login_at = datetime.now(UTC)
    out = await _issue(session, response, user)
    await audit(session, user, "auth.login", "user", user.id, ip=ip)
    await session.commit()
    return out


@router.post("/refresh", response_model=TokenOut)
async def refresh(request: Request, response: Response, session: SessionDep) -> TokenOut:
    ip = client_ip(request)
    if not refresh_limiter.hit(ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many refresh attempts")
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No refresh token")
    try:
        payload = decode_token(raw, "refresh")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token") from exc
    row = await session.get(RefreshToken, payload.get("jti"))
    now = datetime.now(UTC)
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown refresh token")
    if row.revoked_at is not None:
        # Reuse of a rotated token → assume theft, revoke the whole family.
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.family == row.family, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await audit(session, None, "auth.refresh_reuse", "user", row.user_id, ip=ip)
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token reused; session revoked")
    if row.expires_at <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token expired")
    user = await session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")
    row.revoked_at = now
    out = await _issue(session, response, user, family=row.family)
    await session.commit()
    return out


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, session: SessionDep) -> Response:
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw:
        try:
            payload = decode_token(raw, "refresh")
            await session.execute(
                update(RefreshToken)
                .where(RefreshToken.family == payload.get("fam"), RefreshToken.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
            await session.commit()
        except jwt.PyJWTError:
            pass
    response.delete_cookie(REFRESH_COOKIE, path="/api/auth")
    response.status_code = 204
    return response


@router.get("/me", response_model=UserOut)
async def me(user: Viewer) -> UserOut:
    return UserOut.model_validate(user)

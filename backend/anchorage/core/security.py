"""Password hashing (argon2id) and JWT helpers."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from anchorage.core.config import get_settings

_hasher = PasswordHasher()  # argon2id, library defaults (RFC 9106 low-memory profile)

MIN_PASSWORD_LENGTH = 10


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


# A constant hash used to equalise timing when the user does not exist.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def dummy_verify() -> None:
    verify_password(_DUMMY_HASH, "not-the-password")


def create_access_token(user_id: int, role: str) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "typ": "access",
        "iat": now,
        "exp": now + timedelta(minutes=s.access_token_minutes),
    }
    return jwt.encode(payload, s.effective_jwt_secret(), algorithm=s.jwt_algorithm)


def create_refresh_token(user_id: int, family: str | None = None) -> tuple[str, str, str, datetime]:
    """Returns (token, jti, family, expires_at)."""
    s = get_settings()
    now = datetime.now(UTC)
    jti = secrets.token_urlsafe(24)
    family = family or secrets.token_urlsafe(16)
    exp = now + timedelta(days=s.refresh_token_days)
    payload = {"sub": str(user_id), "typ": "refresh", "jti": jti, "fam": family, "iat": now, "exp": exp}
    return jwt.encode(payload, s.effective_jwt_secret(), algorithm=s.jwt_algorithm), jti, family, exp


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    s = get_settings()
    payload: dict[str, Any] = jwt.decode(
        token,
        s.effective_jwt_secret(),
        algorithms=[s.jwt_algorithm],
        options={"require": ["exp", "sub", "typ"]},
    )
    if payload.get("typ") != expected_type:
        raise jwt.InvalidTokenError("wrong token type")
    return payload

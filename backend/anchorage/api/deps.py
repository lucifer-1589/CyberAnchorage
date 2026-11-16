"""Auth / RBAC dependencies."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.core.db import get_session
from anchorage.core.security import decode_token
from anchorage.models import User
from anchorage.models.enums import ROLE_RANK, Role

_bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def current_user(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", {"WWW-Authenticate": "Bearer"})
    return await user_from_token(session, creds.credentials)


async def user_from_token(session: AsyncSession, token: str) -> User:
    try:
        payload = decode_token(token, "access")
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")
    return user


def require_role(minimum: Role) -> Callable[..., Coroutine[Any, Any, User]]:
    async def _dep(user: Annotated[User, Depends(current_user)]) -> User:
        if ROLE_RANK[Role(user.role)] < ROLE_RANK[minimum]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {minimum.value} role")
        return user

    return _dep


Viewer = Annotated[User, Depends(require_role(Role.viewer))]
Analyst = Annotated[User, Depends(require_role(Role.analyst))]
Admin = Annotated[User, Depends(require_role(Role.admin))]


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"

"""User management (admin) + runtime settings."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from anchorage.api.auth import UserOut
from anchorage.api.deps import Admin, SessionDep, Viewer, client_ip
from anchorage.api.types import Email
from anchorage.core.audit import audit
from anchorage.core.runtime_settings import RuntimeSettings, load_runtime_settings, save_runtime_settings
from anchorage.core.security import MIN_PASSWORD_LENGTH, hash_password
from anchorage.models import User
from anchorage.models.enums import Role

router = APIRouter(tags=["users"])


class UserCreate(BaseModel):
    email: Email
    name: str = Field("", max_length=120)
    role: Role = Role.viewer
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=256)


class UserPatch(BaseModel):
    name: str | None = Field(None, max_length=120)
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(None, min_length=MIN_PASSWORD_LENGTH, max_length=256)


def _snap(u: User) -> dict[str, Any]:
    return {"email": u.email, "name": u.name, "role": u.role, "is_active": u.is_active}


@router.get("/users", response_model=list[UserOut])
async def list_users(_: Admin, session: SessionDep) -> list[User]:
    return list((await session.execute(select(User).order_by(User.id))).scalars())


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, admin: Admin, session: SessionDep, request: Request) -> User:
    email = body.email.lower()
    exists = await session.scalar(select(func.count()).select_from(User).where(func.lower(User.email) == email))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with that email already exists")
    user = User(email=email, name=body.name, role=body.role.value, password_hash=hash_password(body.password))
    session.add(user)
    await session.flush()
    await audit(session, admin, "user.create", "user", user.id, after=_snap(user), ip=client_ip(request))
    await session.commit()
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int, body: UserPatch, admin: Admin, session: SessionDep, request: Request
) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    before = _snap(user)
    if user.id == admin.id and (
        (body.role is not None and body.role != Role.admin) or body.is_active is False
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot demote or deactivate yourself")
    if body.name is not None:
        user.name = body.name
    if body.role is not None:
        user.role = body.role.value
    if body.is_active is not None:
        user.is_active = body.is_active
    after = _snap(user)
    if body.password:
        user.password_hash = hash_password(body.password)
        after["password_changed"] = True
    await audit(session, admin, "user.update", "user", user.id, before=before, after=after, ip=client_ip(request))
    await session.commit()
    return user


@router.get("/settings", response_model=RuntimeSettings)
async def get_settings_route(_: Viewer, session: SessionDep) -> RuntimeSettings:
    return await load_runtime_settings(session)


@router.put("/settings", response_model=RuntimeSettings)
async def put_settings(
    body: RuntimeSettings, admin: Admin, session: SessionDep, request: Request
) -> RuntimeSettings:
    before = (await load_runtime_settings(session)).model_dump()
    after = await save_runtime_settings(session, body)
    await audit(session, admin, "settings.update", "settings", "runtime", before, after, client_ip(request))
    await session.commit()
    return body

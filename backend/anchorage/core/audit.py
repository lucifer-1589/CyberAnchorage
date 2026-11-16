"""Audit log helper. Call inside the same transaction as the change it records."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.models import AuditLog, User


async def audit(
    session: AsyncSession,
    actor: User | None,
    action: str,
    entity_type: str,
    entity_id: Any = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    session.add(
        AuditLog(
            actor_id=actor.id if actor else None,
            actor_email=actor.email if actor else "system",
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            before=_jsonable(before),
            after=_jsonable(after),
            ip=ip,
        )
    )


def _jsonable(d: dict[str, Any] | None) -> dict[str, Any] | None:
    if d is None:
        return None
    import json

    return json.loads(json.dumps(d, default=str))

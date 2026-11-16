"""Rule CRUD with versioning + audit. Every change re-evaluates the rule (SQL retro pass)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.core.audit import audit
from anchorage.models import Rule, RuleVersion, User
from anchorage.models.enums import Severity, Verdict
from anchorage.rules.engine import RuleEngine
from anchorage.rules.schema import ConditionError, parse_condition

VERSIONED_FIELDS = ("name", "description", "enabled", "priority", "verdict", "severity", "condition", "expires_at")


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field("", max_length=2000)
    enabled: bool = True
    priority: int = Field(100, ge=0, le=10_000)
    verdict: Verdict
    severity: Severity
    condition: dict[str, Any]
    expires_at: datetime | None = None
    change_note: str = Field("", max_length=240)

    @field_validator("condition")
    @classmethod
    def _valid(cls, v: dict[str, Any]) -> dict[str, Any]:
        try:
            parse_condition(v)
        except ConditionError as exc:
            raise ValueError(str(exc)) from exc
        return v

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


def snapshot(rule: Rule) -> dict[str, Any]:
    return {k: getattr(rule, k) for k in VERSIONED_FIELDS} | {"version": rule.version}


async def _version(session: AsyncSession, rule: Rule, actor: User | None, note: str) -> None:
    import json

    session.add(RuleVersion(rule_id=rule.id, version=rule.version,
                            snapshot=json.loads(json.dumps(snapshot(rule), default=str)),
                            changed_by=actor.id if actor else None,
                            changed_by_email=actor.email if actor else "system", change_note=note))


async def create_rule(session: AsyncSession, data: dict[str, Any] | RuleIn, actor: User | None,
                      evaluate: bool = True, ip: str | None = None) -> Rule:
    is_demo = bool(data.pop("is_demo", False)) if isinstance(data, dict) else False
    body = data if isinstance(data, RuleIn) else RuleIn.model_validate(data)
    rule = Rule(**body.model_dump(exclude={"change_note"}), version=1, is_demo=is_demo,
                created_by=actor.id if actor else None, updated_by=actor.id if actor else None)
    session.add(rule)
    await session.flush()
    await _version(session, rule, actor, body.change_note or "created")
    await audit(session, actor, "rule.create", "rule", rule.id, after=snapshot(rule), ip=ip)
    if evaluate:
        await RuleEngine(session).evaluate_one(rule)
    return rule


async def update_rule(session: AsyncSession, rule: Rule, body: RuleIn, actor: User | None,
                      ip: str | None = None) -> Rule:
    before = snapshot(rule)
    changes = body.model_dump(exclude={"change_note"})
    if all(before[k] == v for k, v in changes.items()):
        return rule
    for k, v in changes.items():
        setattr(rule, k, v)
    rule.version += 1
    rule.updated_by = actor.id if actor else None
    rule.updated_at = datetime.now(UTC)
    await session.flush()
    await _version(session, rule, actor, body.change_note or "updated")
    await audit(session, actor, "rule.update", "rule", rule.id, before=before, after=snapshot(rule), ip=ip)
    await RuleEngine(session).evaluate_one(rule)
    return rule


async def set_enabled(session: AsyncSession, rule: Rule, enabled: bool, actor: User | None,
                      ip: str | None = None) -> Rule:
    if rule.enabled == enabled:
        return rule
    body = RuleIn.model_validate(snapshot(rule) | {"enabled": enabled,
                                                   "change_note": "enabled" if enabled else "disabled"})
    return await update_rule(session, rule, body, actor, ip)


async def delete_rule(session: AsyncSession, rule: Rule, actor: User | None, ip: str | None = None) -> None:
    before = snapshot(rule)
    rule.deleted_at = datetime.now(UTC)
    rule.enabled = False
    await audit(session, actor, "rule.delete", "rule", rule.id, before=before, ip=ip)
    await RuleEngine(session).evaluate_one(rule)  # removes its flags + recomputes verdicts


async def restore_version(session: AsyncSession, rule: Rule, version: int, actor: User | None,
                          ip: str | None = None) -> Rule:
    v = (await session.execute(select(RuleVersion).where(RuleVersion.rule_id == rule.id,
                                                         RuleVersion.version == version))).scalar_one_or_none()
    if v is None:
        raise LookupError("version not found")
    snap = {k: v.snapshot.get(k) for k in VERSIONED_FIELDS}
    body = RuleIn.model_validate(snap | {"change_note": f"restored v{version}"})
    return await update_rule(session, rule, body, actor, ip)

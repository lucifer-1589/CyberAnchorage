"""Rules, flags, allowlist."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from anchorage.api.deps import Analyst, SessionDep, Viewer, client_ip
from anchorage.api.schemas import AllowlistOut, IocOut, Page, RuleOut, RuleVersionOut
from anchorage.core.audit import audit
from anchorage.core.bus import CONTROL, EVENTS, get_bus
from anchorage.models import AllowlistEntry, Ioc, IocFlag, Rule, RuleVersion
from anchorage.models.enums import AllowKind
from anchorage.rules.allowlist import entry_node, normalized_value
from anchorage.rules.engine import RuleEngine
from anchorage.rules.schema import ConditionError, fields_catalog, parse_condition
from anchorage.rules.service import RuleIn, create_rule, delete_rule, restore_version, set_enabled, update_rule

router = APIRouter(tags=["rules"])


async def _get_rule(session: SessionDep, rule_id: int) -> Rule:
    rule = await session.get(Rule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found")
    return rule


# ------------------------------------------------------------------ rules ---

@router.get("/rules/fields")
async def rule_fields(_: Viewer) -> dict[str, Any]:
    return {"fields": fields_catalog(), "verdicts": ["abnormal", "suspicious", "malicious"],
            "severities": ["low", "medium", "high", "critical"]}


@router.get("/rules", response_model=list[RuleOut])
async def list_rules(_: Viewer, session: SessionDep) -> list[Rule]:
    q = select(Rule).where(Rule.deleted_at.is_(None)).order_by(Rule.priority, Rule.id)
    return list((await session.execute(q)).scalars())


class DryRunIn(BaseModel):
    condition: dict[str, Any]


class DryRunOut(BaseModel):
    count: int
    allowlisted: int
    samples: list[IocOut]


@router.post("/rules/dry-run", response_model=DryRunOut)
async def dry_run(body: DryRunIn, _: Viewer, session: SessionDep) -> dict[str, Any]:
    try:
        parse_condition(body.condition)
    except ConditionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    res = await RuleEngine(session).dry_run(body.condition)
    res["samples"] = [IocOut.model_validate(i) for i in res["samples"]]  # serialize before ending the tx
    await session.rollback()
    return res


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create(body: RuleIn, user: Analyst, session: SessionDep, request: Request) -> Rule:
    rule = await create_rule(session, body, user, ip=client_ip(request))
    await session.commit()
    await get_bus().publish(EVENTS, "rule.changed", {"id": rule.id, "action": "created"})
    return rule


@router.get("/rules/{rule_id}", response_model=RuleOut)
async def get_rule(rule_id: int, _: Viewer, session: SessionDep) -> Rule:
    return await _get_rule(session, rule_id)


@router.put("/rules/{rule_id}", response_model=RuleOut)
async def put_rule(rule_id: int, body: RuleIn, user: Analyst, session: SessionDep, request: Request) -> Rule:
    rule = await update_rule(session, await _get_rule(session, rule_id), body, user, client_ip(request))
    await session.commit()
    await get_bus().publish(EVENTS, "rule.changed", {"id": rule.id, "action": "updated"})
    return rule


class ToggleIn(BaseModel):
    enabled: bool


@router.post("/rules/{rule_id}/toggle", response_model=RuleOut)
async def toggle(rule_id: int, body: ToggleIn, user: Analyst, session: SessionDep, request: Request) -> Rule:
    rule = await set_enabled(session, await _get_rule(session, rule_id), body.enabled, user, client_ip(request))
    await session.commit()
    await get_bus().publish(EVENTS, "rule.changed", {"id": rule.id, "action": "toggled"})
    return rule


@router.delete("/rules/{rule_id}", status_code=204, response_model=None)
async def remove(rule_id: int, user: Analyst, session: SessionDep, request: Request) -> None:
    await delete_rule(session, await _get_rule(session, rule_id), user, client_ip(request))
    await session.commit()
    await get_bus().publish(EVENTS, "rule.changed", {"id": rule_id, "action": "deleted"})


@router.get("/rules/{rule_id}/versions", response_model=list[RuleVersionOut])
async def versions(rule_id: int, _: Viewer, session: SessionDep) -> list[RuleVersion]:
    await _get_rule(session, rule_id)
    q = select(RuleVersion).where(RuleVersion.rule_id == rule_id).order_by(RuleVersion.version.desc())
    return list((await session.execute(q)).scalars())


@router.post("/rules/{rule_id}/restore/{version}", response_model=RuleOut)
async def restore(rule_id: int, version: int, user: Analyst, session: SessionDep, request: Request) -> Rule:
    try:
        rule = await restore_version(session, await _get_rule(session, rule_id), version, user, client_ip(request))
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    await session.commit()
    return rule


@router.post("/rules/reevaluate")
async def reevaluate(_: Analyst, session: SessionDep) -> dict[str, Any]:
    res = await RuleEngine(session).evaluate_all()
    await session.commit()
    return res


# ------------------------------------------------------------------ flags ---

class FlagOut(BaseModel):
    id: int
    ts: datetime
    updated_at: datetime
    verdict: str
    severity: str
    rule_id: int
    rule_name: str
    rule_version: int
    ioc: IocOut


@router.get("/flags", response_model=Page)
async def list_flags(
    _: Viewer,
    session: SessionDep,
    verdict: list[str] = Query(default=[]),
    severity: list[str] = Query(default=[]),
    rule_id: int | None = None,
    ioc_id: int | None = None,
    q: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Page:
    stmt = select(IocFlag, Rule.name, Ioc).join(Rule, Rule.id == IocFlag.rule_id).join(Ioc, Ioc.id == IocFlag.ioc_id)
    if verdict:
        stmt = stmt.where(IocFlag.verdict.in_(verdict))
    if severity:
        stmt = stmt.where(IocFlag.severity.in_(severity))
    if rule_id:
        stmt = stmt.where(IocFlag.rule_id == rule_id)
    if ioc_id:
        stmt = stmt.where(IocFlag.ioc_id == ioc_id)
    if q:
        stmt = stmt.where(or_(Ioc.value_norm.ilike(f"%{_esc(q)}%", escape="\\"),
                              Rule.name.ilike(f"%{_esc(q)}%", escape="\\")))
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await session.execute(stmt.order_by(IocFlag.severity_rank.desc(), IocFlag.ts.desc())
                                  .limit(limit).offset(offset))).all()
    items = [FlagOut(id=f.id, ts=f.ts, updated_at=f.updated_at, verdict=f.verdict, severity=f.severity,
                     rule_id=f.rule_id, rule_name=name, rule_version=f.rule_version,
                     ioc=IocOut.model_validate(ioc)) for f, name, ioc in rows]
    return Page(items=items, total=int(total or 0), limit=limit, offset=offset)


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# -------------------------------------------------------------- allowlist ---

class AllowIn(BaseModel):
    kind: AllowKind
    value: str = Field(min_length=1, max_length=512)
    ioc_type: str | None = Field(None, max_length=16)
    reason: str = Field("", max_length=1000)
    expires_at: datetime | None = None


@router.get("/allowlist", response_model=list[AllowlistOut])
async def list_allow(_: Viewer, session: SessionDep) -> list[AllowlistEntry]:
    return list((await session.execute(select(AllowlistEntry).order_by(AllowlistEntry.id.desc()))).scalars())


@router.post("/allowlist/preview")
async def preview_allow(body: AllowIn, _: Viewer, session: SessionDep) -> dict[str, Any]:
    from anchorage.rules.compile import EvalContext, compile_sql

    try:
        node = entry_node(body.kind, body.value, body.ioc_type)
    except ConditionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    cond = compile_sql(node, EvalContext(now=datetime.now().astimezone()))
    total = await session.scalar(select(func.count()).select_from(Ioc).where(cond))
    flagged = await session.scalar(select(func.count()).select_from(Ioc).where(cond, Ioc.verdict.is_not(None)))
    return {"matches": int(total or 0), "currently_flagged": int(flagged or 0)}


@router.post("/allowlist", response_model=AllowlistOut, status_code=201)
async def add_allow(body: AllowIn, user: Analyst, session: SessionDep, request: Request) -> AllowlistEntry:
    try:
        value = normalized_value(body.kind, body.value, body.ioc_type)
    except ConditionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    entry = AllowlistEntry(kind=body.kind.value, value=value, ioc_type=body.ioc_type, reason=body.reason,
                           expires_at=body.expires_at, created_by=user.id, created_by_email=user.email)
    session.add(entry)
    await session.flush()
    await audit(session, user, "allowlist.create", "allowlist", entry.id,
                after={"kind": entry.kind, "value": entry.value, "ioc_type": entry.ioc_type, "reason": entry.reason},
                ip=client_ip(request))
    await RuleEngine(session).evaluate_all()
    await session.commit()
    await get_bus().publish(CONTROL, "index.rebuild", {"reason": "allowlist"})
    return entry


@router.delete("/allowlist/{entry_id}", status_code=204, response_model=None)
async def delete_allow(entry_id: int, user: Analyst, session: SessionDep, request: Request) -> None:
    entry = await session.get(AllowlistEntry, entry_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Allowlist entry not found")
    before = {"kind": entry.kind, "value": entry.value, "ioc_type": entry.ioc_type, "reason": entry.reason}
    await session.delete(entry)
    await session.flush()
    await audit(session, user, "allowlist.delete", "allowlist", entry_id, before=before, ip=client_ip(request))
    await RuleEngine(session).evaluate_all()
    await session.commit()
    await get_bus().publish(CONTROL, "index.rebuild", {"reason": "allowlist"})

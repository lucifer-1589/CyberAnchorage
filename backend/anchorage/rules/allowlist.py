"""Allowlist: entries always override rules. Implemented with the same leaf compilers as rules."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, false, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.ioc.normalize import Rejected, normalize
from anchorage.models import AllowlistEntry, Ioc
from anchorage.models.enums import AllowKind
from anchorage.rules.compile import EvalContext, Predicate, compile_python, compile_sql
from anchorage.rules.schema import ConditionError, Group, Leaf, Node, parse_condition

_OP = {AllowKind.value: "equals", AllowKind.cidr: "in_cidr", AllowKind.domain_suffix: "domain_suffix"}


def entry_node(kind: str, value: str, ioc_type: str | None = None) -> Node:
    """Translate an allowlist entry into a condition node (raises ConditionError if invalid)."""
    if kind not in _OP:
        raise ConditionError(f"unknown allowlist kind {kind!r}")
    if kind == AllowKind.value and ioc_type:
        try:
            value = normalize(ioc_type, value, allow_private=True).value
        except Rejected as exc:
            raise ConditionError(f"invalid {ioc_type}: {exc}") from exc
    leaf = parse_condition({"field": "value", "operator": _OP[AllowKind(kind)], "value": value})
    if ioc_type:
        return Group("and", [parse_condition({"field": "type", "operator": "eq", "value": ioc_type}), leaf])
    return leaf


def normalized_value(kind: str, value: str, ioc_type: str | None) -> str:
    node = entry_node(kind, value, ioc_type)
    leaf = node.children[1] if isinstance(node, Group) else node
    assert isinstance(leaf, Leaf)
    return leaf.arg["suffix"] if isinstance(leaf.arg, dict) else str(leaf.arg)


async def active_entries(session: AsyncSession, now: datetime | None = None) -> list[AllowlistEntry]:
    now = now or datetime.now(UTC)
    q = select(AllowlistEntry).where(or_(AllowlistEntry.expires_at.is_(None), AllowlistEntry.expires_at > now))
    return list((await session.execute(q)).scalars())


def sql_any(entries: list[AllowlistEntry], ctx: EvalContext) -> ColumnElement[bool]:
    parts = [compile_sql(entry_node(e.kind, e.value, e.ioc_type), ctx) for e in entries]
    return or_(false(), *parts)


def python_any(entries: list[AllowlistEntry] | list[dict[str, Any]], ctx: EvalContext) -> Predicate:
    preds = []
    for e in entries:
        kind, value, t = (e["kind"], e["value"], e.get("ioc_type")) if isinstance(e, dict) else (
            e.kind, e.value, e.ioc_type)
        preds.append(compile_python(entry_node(kind, value, t), ctx))
    return lambda v: any(p(v) for p in preds)


async def refresh_allowlisted(session: AsyncSession, now: datetime | None = None) -> int:
    """Recompute iocs.allowlisted; returns number of rows whose flag changed."""
    now = now or datetime.now(UTC)
    ctx = EvalContext(now=now)
    cond = sql_any(await active_entries(session, now), ctx)
    res = await session.execute(update(Ioc).where(Ioc.allowlisted.is_distinct_from(cond))
                                .values(allowlisted=cond).execution_options(synchronize_session=False))
    return int(res.rowcount or 0)

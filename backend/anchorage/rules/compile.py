"""Compile a validated condition AST to (a) a Python predicate and (b) a SQLAlchemy expression.

Both compilers live in one module so their semantics stay side by side; `tests/integration/test_rules_parity.py`
asserts they select exactly the same IOCs. SQL leaves are wrapped in COALESCE(…, false) so NULL columns behave
like Python's "missing → no match", including under NOT.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import regex as safe_regex
from sqlalchemy import ColumnElement, and_, cast, exists, false, func, literal, not_, or_, select, true
from sqlalchemy.dialects.postgresql import ARRAY, CIDR
from sqlalchemy.types import Text

from anchorage.models import Ioc
from anchorage.rules.schema import Group, Leaf, Node, Not

Predicate = Callable[[dict[str, Any]], bool]

# ======================================================================= view ===


def ioc_view(ioc: Any) -> dict[str, Any]:
    """Uniform dict the Python predicate reads (from an Ioc row, a mapping, or a real-time observable)."""
    get = ioc.get if isinstance(ioc, dict) else lambda k, d=None: getattr(ioc, k, d)
    ip, net = get("ip"), get("net")
    return {
        "type": get("type"), "value": get("value_norm") or get("value") or "",
        "ip": str(ip) if ip is not None else None, "net": str(net) if net is not None else None,
        "port": get("port"), "asn": get("asn"), "host": get("host"),
        "sources": list(get("sources") or []), "source_count": get("source_count") or 0,
        "confidence": get("confidence") or 0.0, "score": get("score") or 0.0,
        "tags": [t.lower() for t in get("tags") or []],
        "malware_families": [m.lower() for m in get("malware_families") or []],
        "actors": [a.lower() for a in get("actors") or []],
        "mitre_ids": [m.lower() for m in get("mitre_ids") or []],
        "first_seen": get("first_seen"), "last_seen": get("last_seen"),
        "tlp_rank": get("tlp_rank") if get("tlp_rank") is not None else 2,
    }


_ARRAY_KEYS = {"source": "sources", "tags": "tags", "malware_family": "malware_families", "actor": "actors",
               "mitre": "mitre_ids"}
_NUM_KEYS = {"source_count": "source_count", "confidence": "confidence", "score": "score", "port": "port"}
_AGE_KEYS = {"first_seen_age_days": "first_seen", "last_seen_age_days": "last_seen"}


@dataclass
class EvalContext:
    now: datetime
    regex_timeout: float = 0.05


# ================================================================== python ===


def _cmp(op: str, x: float | None, arg: Any) -> bool:
    if x is None:
        return False
    match op:
        case "eq":
            return x == arg
        case "neq":
            return x != arg
        case "gt":
            return x > arg
        case "gte":
            return x >= arg
        case "lt":
            return x < arg
        case "lte":
            return x <= arg
        case "between":
            return arg[0] <= x <= arg[1]
        case "in":
            return x in arg
        case "not_in":
            return x not in arg
    raise ValueError(op)


def _in_cidr(view: dict[str, Any], cidr: str) -> bool:
    net = ipaddress.ip_network(cidr)
    if view.get("ip"):
        try:
            return ipaddress.ip_address(view["ip"]) in net
        except ValueError:
            return False
    if view.get("net"):
        other = ipaddress.ip_network(view["net"])
        return other.version == net.version and other.subnet_of(net)  # type: ignore[arg-type]
    return False


def _py_leaf(leaf: Leaf, ctx: EvalContext) -> Predicate:
    f, op, arg = leaf.field, leaf.operator, leaf.arg
    if f == "type":
        if op in ("eq", "in"):
            return lambda v: v["type"] in arg
        return lambda v: v["type"] is not None and v["type"] not in arg
    if f in _ARRAY_KEYS:
        key = _ARRAY_KEYS[f]
        want = set(arg)
        if f == "source":
            def items(v: dict[str, Any]) -> set[str]:
                return {s.lower() for s in v[key]}
        else:
            def items(v: dict[str, Any]) -> set[str]:
                return set(v[key])
        if op == "has_any":
            return lambda v: bool(items(v) & want)
        if op == "has_all":
            return lambda v: want <= items(v)
        return lambda v: not (items(v) & want)
    if f in _NUM_KEYS:
        key = _NUM_KEYS[f]
        return lambda v: _cmp(op, v[key], arg)
    if f in _AGE_KEYS:
        key = _AGE_KEYS[f]

        def age(v: dict[str, Any]) -> float | None:
            ts = v[key]
            return None if ts is None else (ctx.now - ts).total_seconds() / 86400

        return lambda v: _cmp(op, age(v), arg)
    if f == "tlp":
        if op in ("eq", "in"):
            return lambda v: v["tlp_rank"] in arg
        if op == "neq":
            return lambda v: v["tlp_rank"] not in arg
        if op == "gte":
            return lambda v: v["tlp_rank"] >= arg[0]
        return lambda v: v["tlp_rank"] <= arg[0]
    if f == "asn":
        if op in ("eq", "in"):
            return lambda v: v["asn"] is not None and v["asn"] in arg
        return lambda v: v["asn"] is not None and v["asn"] not in arg
    if f == "value":
        return _py_value(op, arg, ctx)
    raise ValueError(f"no python compiler for {f}")


def _py_value(op: str, arg: Any, ctx: EvalContext) -> Predicate:
    if op == "equals":
        return lambda v: v["value"] == arg
    if op == "in":
        s = set(arg)
        return lambda v: v["value"] in s
    if op == "not_in":
        s = set(arg)
        return lambda v: v["value"] not in s
    if op == "in_cidr":
        return lambda v: _in_cidr(v, arg)
    if op == "domain_suffix":
        suffix = arg["suffix"]
        return lambda v: bool(v["host"]) and (v["host"] == suffix or v["host"].endswith("." + suffix))
    # text operators are case-insensitive (arg is already lowercased by the validator)
    if op == "contains":
        return lambda v: arg in v["value"].lower()
    if op == "starts_with":
        return lambda v: v["value"].lower().startswith(arg)
    if op == "ends_with":
        return lambda v: v["value"].lower().endswith(arg)
    if op == "wildcard":
        glob = re.compile("".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in arg), re.S)
        return lambda v: glob.fullmatch(v["value"].lower()) is not None
    if op == "regex":
        pat = safe_regex.compile(arg, safe_regex.IGNORECASE)

        def regex_match(v: dict[str, Any]) -> bool:
            try:
                return pat.search(v["value"], timeout=ctx.regex_timeout) is not None
            except TimeoutError:
                return False

        return regex_match
    raise ValueError(op)


def compile_python(node: Node, ctx: EvalContext) -> Predicate:
    if isinstance(node, Leaf):
        return _py_leaf(node, ctx)
    if isinstance(node, Not):
        inner = compile_python(node.child, ctx)
        return lambda v: not inner(v)
    preds = [compile_python(c, ctx) for c in node.children]
    if node.op == "and":
        return lambda v: all(p(v) for p in preds)
    return lambda v: any(p(v) for p in preds)


# ===================================================================== sql ===


def _like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _glob_to_like(pattern: str) -> str:
    out = []
    for ch in pattern:
        if ch == "*":
            out.append("%")
        elif ch == "?":
            out.append("_")
        else:
            out.append(_like_escape(ch))
    return "".join(out)


_SQL_ARRAY_COLS = {"source": Ioc.sources, "tags": Ioc.tags, "malware_family": Ioc.malware_families,
                   "actor": Ioc.actors, "mitre": Ioc.mitre_ids}
_SQL_NUM_COLS = {"source_count": Ioc.source_count, "confidence": Ioc.confidence, "score": Ioc.score,
                 "port": Ioc.port}


def _sql_cmp(op: str, col: Any, arg: Any) -> ColumnElement[bool]:
    match op:
        case "eq":
            return col == arg
        case "neq":
            return col != arg
        case "gt":
            return col > arg
        case "gte":
            return col >= arg
        case "lt":
            return col < arg
        case "lte":
            return col <= arg
        case "between":
            return col.between(arg[0], arg[1])
        case "in":
            return col.in_(arg)
        case "not_in":
            return col.not_in(arg)
    raise ValueError(op)


def _sql_array(f: str, op: str, arg: list[str]) -> ColumnElement[bool]:
    col = _SQL_ARRAY_COLS[f]
    if f == "tags":  # stored lowercase → index-friendly array operators
        vals = cast(literal(arg, ARRAY(Text)), ARRAY(Text))
        if op == "has_any":
            return col.op("&&")(vals)
        if op == "has_all":
            return col.op("@>")(vals)
        return not_(col.op("&&")(vals))
    elem = func.unnest(col).table_valued("x").render_derived(name="u")  # unnest(col) AS u(x)
    if op == "has_all":
        return and_(*[exists(select(1).select_from(elem).where(func.lower(elem.c.x) == a)) for a in arg])
    hit = exists(select(1).select_from(elem).where(func.lower(elem.c.x).in_(arg)))
    return hit if op == "has_any" else not_(hit)


def _sql_leaf(leaf: Leaf, ctx: EvalContext) -> ColumnElement[bool]:
    f, op, arg = leaf.field, leaf.operator, leaf.arg
    if f == "type":
        return Ioc.type.in_(arg) if op in ("eq", "in") else Ioc.type.not_in(arg)
    if f in _SQL_ARRAY_COLS:
        return _sql_array(f, op, arg)
    if f in _SQL_NUM_COLS:
        return _sql_cmp(op, _SQL_NUM_COLS[f], arg)
    if f in _AGE_KEYS:
        col = Ioc.first_seen if f == "first_seen_age_days" else Ioc.last_seen

        def at(days: float) -> datetime:
            return ctx.now - timedelta(days=days)

        # age > N  ⇔  ts < now - N   (direction flips)
        match op:
            case "gt":
                return col < at(arg)
            case "gte":
                return col <= at(arg)
            case "lt":
                return col > at(arg)
            case "lte":
                return col >= at(arg)
            case "between":
                return and_(col <= at(arg[0]), col >= at(arg[1]))
    if f == "tlp":
        if op in ("eq", "in"):
            return Ioc.tlp_rank.in_(arg)
        if op == "neq":
            return Ioc.tlp_rank.not_in(arg)
        return Ioc.tlp_rank >= arg[0] if op == "gte" else Ioc.tlp_rank <= arg[0]
    if f == "asn":
        return Ioc.asn.in_(arg) if op in ("eq", "in") else Ioc.asn.not_in(arg)
    if f == "value":
        return _sql_value(op, arg)
    raise ValueError(f"no sql compiler for {f}")


def _sql_value(op: str, arg: Any) -> ColumnElement[bool]:
    v = Ioc.value_norm
    if op == "equals":
        return v == arg
    if op == "in":
        return v.in_(arg)
    if op == "not_in":
        return v.not_in(arg)
    if op == "in_cidr":
        c = cast(literal(arg), CIDR)
        return or_(Ioc.ip.op("<<=")(c), and_(func.family(Ioc.net) == func.family(c), Ioc.net.op("<<=")(c)))
    if op == "domain_suffix":
        return Ioc.host_rev.like(_like_escape(arg["rev"]) + "%", escape="\\")
    if op == "contains":
        return v.ilike("%" + _like_escape(arg) + "%", escape="\\")
    if op == "starts_with":
        return v.ilike(_like_escape(arg) + "%", escape="\\")
    if op == "ends_with":
        return v.ilike("%" + _like_escape(arg), escape="\\")
    if op == "wildcard":
        return v.ilike(_glob_to_like(arg), escape="\\")
    if op == "regex":
        return v.op("~*")(arg)
    raise ValueError(op)


def compile_sql(node: Node, ctx: EvalContext) -> ColumnElement[bool]:
    if isinstance(node, Leaf):
        return func.coalesce(_sql_leaf(node, ctx), false())
    if isinstance(node, Not):
        return not_(compile_sql(node.child, ctx))
    parts = [compile_sql(c, ctx) for c in node.children]
    return and_(true(), *parts) if node.op == "and" else or_(false(), *parts)


def is_group(node: Node) -> bool:
    return isinstance(node, Group)

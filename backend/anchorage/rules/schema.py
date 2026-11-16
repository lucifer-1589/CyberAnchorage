"""Rule condition AST + server-side validation.

Condition JSON:
  group : {"op": "and"|"or", "children": [node, ...]}
  not   : {"op": "not", "child": node}
  leaf  : {"field": <field>, "operator": <operator>, "value": <value>}

Validation normalizes leaf values (e.g. CIDRs canonicalized, IOC values normalized) into `Leaf.arg`,
which both compilers consume. The user's original JSON is what gets stored.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from typing import Any, Literal

import regex as safe_regex

from anchorage.ioc.normalize import CANONICAL_TYPES, Rejected, guess, reverse_host
from anchorage.models.enums import TLP_RANK

MAX_DEPTH = 8
MAX_LEAVES = 100
MAX_LIST = 1000
MAX_REGEX_LEN = 256
MAX_STRING = 512

NUMERIC_OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "between")
AGE_OPS = ("gt", "gte", "lt", "lte", "between")
ARRAY_OPS = ("has_any", "has_all", "has_none")
VALUE_OPS = ("equals", "in", "not_in", "in_cidr", "domain_suffix", "wildcard", "regex", "contains",
             "starts_with", "ends_with")

FieldKind = Literal["enum", "value", "array", "number", "age", "tlp", "int_set"]


@dataclass(frozen=True)
class FieldSpec:
    name: str
    label: str
    kind: FieldKind
    operators: tuple[str, ...]
    help: str = ""
    options: tuple[str, ...] = ()
    min: float | None = None
    max: float | None = None


FIELDS: dict[str, FieldSpec] = {f.name: f for f in [
    FieldSpec("type", "IOC type", "enum", ("eq", "neq", "in", "not_in"), options=CANONICAL_TYPES),
    FieldSpec("value", "Value", "value", VALUE_OPS,
              help="Normalized IOC value. in_cidr matches IPs/networks; "
                   "domain_suffix matches the host and subdomains."),
    FieldSpec("source", "Source", "array", ARRAY_OPS, help="CTI source names, e.g. telegram, crawler"),
    FieldSpec("source_count", "Source count", "number", NUMERIC_OPS, min=0, max=1000),
    FieldSpec("confidence", "Confidence (0-1)", "number", NUMERIC_OPS, min=0, max=1),
    FieldSpec("score", "Score (0-1)", "number", NUMERIC_OPS, min=0, max=1),
    FieldSpec("tags", "Tags", "array", ARRAY_OPS),
    FieldSpec("malware_family", "Malware family", "array", ARRAY_OPS),
    FieldSpec("actor", "Threat actor", "array", ARRAY_OPS),
    FieldSpec("mitre", "MITRE ATT&CK id", "array", ARRAY_OPS),
    FieldSpec("first_seen_age_days", "First seen (days ago)", "age", AGE_OPS, min=0, max=36500),
    FieldSpec("last_seen_age_days", "Last seen (days ago)", "age", AGE_OPS, min=0, max=36500),
    FieldSpec("tlp", "TLP", "tlp", ("eq", "neq", "in", "gte", "lte"), options=tuple(TLP_RANK)),
    FieldSpec("port", "Port", "number", (*NUMERIC_OPS, "in", "not_in"), min=0, max=65535),
    FieldSpec("asn", "ASN", "int_set", ("eq", "neq", "in", "not_in")),
]}


class ConditionError(ValueError):
    def __init__(self, message: str, path: str = "") -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.path = path


# --------------------------------------------------------------- nodes ---

@dataclass
class Leaf:
    field: str
    operator: str
    value: Any
    arg: Any = None  # normalized argument for compilers


@dataclass
class Group:
    op: Literal["and", "or"]
    children: list[Node] = field(default_factory=list)


@dataclass
class Not:
    child: Node


Node = Leaf | Group | Not


# ---------------------------------------------------------- validation ---

# Unbounded quantifier nested in an unbounded quantifier — (a+)+, (a*)*, (\w+\.){2,} — is the classic
# catastrophic-backtracking shape. Bounded repeats such as (\d{1,3}\.){3} are fine.
_UNBOUNDED = r"(?:[+*]|\{\d*,\})"
_NESTED_QUANT = re.compile(r"\((?:[^()\\]|\\.)*" + _UNBOUNDED + r"(?:[^()\\]|\\.)*\)\s*" + _UNBOUNDED)
_BACKREF = re.compile(r"\\[1-9]|\(\?<|\(\?P[<=]")


def validate_regex(pattern: str) -> str:
    if not isinstance(pattern, str) or not pattern:
        raise ConditionError("regex must be a non-empty string")
    if len(pattern) > MAX_REGEX_LEN:
        raise ConditionError(f"regex longer than {MAX_REGEX_LEN} characters")
    if _NESTED_QUANT.search(pattern):
        raise ConditionError("nested quantifiers are not allowed (catastrophic backtracking risk)")
    if _BACKREF.search(pattern):
        raise ConditionError("backreferences, lookbehind and named groups are not supported")
    try:
        safe_regex.compile(pattern, safe_regex.IGNORECASE)
    except safe_regex.error as exc:
        raise ConditionError(f"invalid regex: {exc}") from exc
    return pattern


def _num(v: Any, spec: FieldSpec, path: str) -> float:
    if isinstance(v, bool) or not isinstance(v, int | float):
        try:
            v = float(v)
        except (TypeError, ValueError) as exc:
            raise ConditionError(f"{spec.label} needs a number", path) from exc
    if (spec.min is not None and v < spec.min) or (spec.max is not None and v > spec.max):
        raise ConditionError(f"{spec.label} must be between {spec.min} and {spec.max}", path)
    return float(v)


def _str_list(v: Any, path: str, lower: bool = False) -> list[str]:
    items = v if isinstance(v, list) else [v]
    if not items or len(items) > MAX_LIST:
        raise ConditionError(f"needs 1..{MAX_LIST} values", path)
    out = []
    for item in items:
        if not isinstance(item, str | int) or isinstance(item, bool) or not str(item).strip():
            raise ConditionError("values must be non-empty strings", path)
        s = str(item).strip()
        if len(s) > MAX_STRING:
            raise ConditionError("value too long", path)
        out.append(s.lower() if lower else s)
    return out


def _norm_ioc_value(v: str) -> str:
    g = guess(v)
    return g.value if g else v.strip().lower()


def _validate_leaf(raw: dict[str, Any], path: str) -> Leaf:
    fname, op, value = raw.get("field"), raw.get("operator"), raw.get("value")
    if not isinstance(fname, str) or fname not in FIELDS:
        raise ConditionError(f"unknown field {fname!r}", path)
    spec = FIELDS[fname]
    if op not in spec.operators:
        raise ConditionError(f"operator {op!r} not allowed for {spec.label} (allowed: {', '.join(spec.operators)})",
                             path)
    leaf = Leaf(fname, op, value)

    if spec.kind == "enum":
        vals = _str_list(value, path, lower=True)
        bad = [v for v in vals if v not in spec.options]
        if bad:
            raise ConditionError(f"unknown {spec.label}: {', '.join(bad)}", path)
        if op in ("eq", "neq") and len(vals) != 1:
            raise ConditionError("needs exactly one value", path)
        leaf.arg = vals
    elif spec.kind == "tlp":
        vals = [v.upper().replace("TLP:", "") for v in _str_list(value, path)]
        vals = ["CLEAR" if v == "WHITE" else v for v in vals]
        bad = [v for v in vals if v not in TLP_RANK]
        if bad:
            raise ConditionError(f"unknown TLP: {', '.join(bad)}", path)
        leaf.arg = [TLP_RANK[v] for v in vals]
        if op != "in" and len(vals) != 1:
            raise ConditionError("needs exactly one TLP", path)
    elif spec.kind == "array":
        leaf.arg = _str_list(value, path, lower=True)
    elif spec.kind in ("number", "age"):
        if op == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise ConditionError("between needs [min, max]", path)
            lo, hi = _num(value[0], spec, path), _num(value[1], spec, path)
            if lo > hi:
                raise ConditionError("between: min > max", path)
            leaf.arg = [lo, hi]
        elif op in ("in", "not_in"):
            nvals: list[Any] = value if isinstance(value, list) else [value]
            if not nvals or len(nvals) > MAX_LIST:
                raise ConditionError(f"needs 1..{MAX_LIST} values", path)
            leaf.arg = [_num(v, spec, path) for v in nvals]
        else:
            leaf.arg = _num(value, spec, path)
    elif spec.kind == "int_set":  # asn
        vals = _str_list(value, path)
        nums = []
        for v in vals:
            m = re.fullmatch(r"(?i)(?:AS)?(\d{1,10})", v.replace(" ", ""))
            if not m:
                raise ConditionError(f"invalid ASN {v!r}", path)
            nums.append(int(m.group(1)))
        if op in ("eq", "neq") and len(nums) != 1:
            raise ConditionError("needs exactly one ASN", path)
        leaf.arg = nums
    elif spec.kind == "value":
        leaf.arg = _validate_value_arg(op, value, path)
    return leaf


def _validate_value_arg(op: str, value: Any, path: str) -> Any:
    if op in ("in", "not_in"):
        return [_norm_ioc_value(v) for v in _str_list(value, path)]
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_STRING:
        raise ConditionError("needs a non-empty string value", path)
    v = value.strip()
    if op == "equals":
        return _norm_ioc_value(v)
    if op == "in_cidr":
        try:
            net = ipaddress.ip_network(v, strict=False)
        except ValueError as exc:
            raise ConditionError(f"invalid CIDR {v!r}", path) from exc
        return net.compressed
    if op == "domain_suffix":
        d = v.lower().lstrip("*.").rstrip(".")
        if not re.fullmatch(r"[a-z0-9_-]+(\.[a-z0-9_-]+)*", d):
            raise ConditionError(f"invalid domain suffix {v!r}", path)
        return {"suffix": d, "rev": reverse_host(d)}
    if op == "regex":
        return validate_regex(v)
    if op == "wildcard":
        if len(v) > MAX_REGEX_LEN:
            raise ConditionError("pattern too long", path)
        return v.lower()
    return v.lower()  # contains / starts_with / ends_with


def parse_condition(data: Any, path: str = "$", depth: int = 0, counter: list[int] | None = None) -> Node:
    counter = counter if counter is not None else [0]
    if depth > MAX_DEPTH:
        raise ConditionError(f"nesting deeper than {MAX_DEPTH}", path)
    if not isinstance(data, dict):
        raise ConditionError("node must be an object", path)
    if "field" in data:
        counter[0] += 1
        if counter[0] > MAX_LEAVES:
            raise ConditionError(f"more than {MAX_LEAVES} conditions")
        extra = set(data) - {"field", "operator", "value", "id"}
        if extra:
            raise ConditionError(f"unexpected keys {sorted(extra)}", path)
        return _validate_leaf(data, path)
    op = data.get("op")
    if op == "not":
        if "child" not in data:
            raise ConditionError("not needs a child", path)
        return Not(parse_condition(data["child"], f"{path}.child", depth + 1, counter))
    if op in ("and", "or"):
        children = data.get("children")
        if not isinstance(children, list) or not children:
            raise ConditionError(f"{op} needs at least one child", path)
        return Group(op, [parse_condition(c, f"{path}.children[{i}]", depth + 1, counter)
                          for i, c in enumerate(children)])
    raise ConditionError(f"unknown op {op!r}", path)


def fields_catalog() -> list[dict[str, Any]]:
    return [{"name": f.name, "label": f.label, "kind": f.kind, "operators": list(f.operators), "help": f.help,
             "options": list(f.options), "min": f.min, "max": f.max} for f in FIELDS.values()]


__all__ = ["FIELDS", "ConditionError", "Group", "Leaf", "Node", "Not", "Rejected", "fields_catalog",
           "parse_condition", "validate_regex"]

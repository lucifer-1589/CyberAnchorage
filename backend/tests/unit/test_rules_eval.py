from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from anchorage.ioc.normalize import normalize
from anchorage.rules.allowlist import python_any
from anchorage.rules.compile import EvalContext, compile_python, ioc_view
from anchorage.rules.schema import ConditionError, parse_condition

NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)
CTX = EvalContext(now=NOW)


def ioc(src_type: str, value: str, **kw: Any) -> dict[str, Any]:
    n = normalize(src_type, value, allow_private=True)
    base = {"type": n.type, "value_norm": n.value, "ip": n.ip, "net": n.net, "port": n.port, "asn": n.asn,
            "host": n.host, "sources": ["crawler"], "source_count": 1, "score": 0.5, "confidence": 0.6,
            "tags": [], "malware_families": [], "actors": [], "mitre_ids": [], "tlp_rank": 2,
            "first_seen": NOW - timedelta(days=10), "last_seen": NOW - timedelta(days=1)}
    base.update(kw)
    return ioc_view(base)


def match(cond: dict[str, Any], view: dict[str, Any]) -> bool:
    return compile_python(parse_condition(cond), CTX)(view)


def leaf(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"field": field, "operator": op, "value": value}


# ------------------------------------------------------------------- CIDR ---

@pytest.mark.parametrize(("t", "v", "cidr", "expected"), [
    ("ipv4", "45.9.148.10", "45.9.148.0/24", True),
    ("ipv4", "45.9.149.10", "45.9.148.0/24", False),
    ("ipv4", "45.9.148.10", "45.9.148.10/32", True),
    ("cidr", "45.9.148.0/25", "45.9.148.0/24", True),  # subnet inside
    ("cidr", "45.9.0.0/16", "45.9.148.0/24", False),  # supernet is not inside
    ("ipv6", "2a00:1450:4001::1", "2a00:1450::/32", True),
    ("ipv6", "2a00:1450:4001::1", "45.9.148.0/24", False),  # family mismatch
    ("ipv4_port", "45.9.148.10:4444", "45.9.148.0/24", True),
    ("url", "http://45.9.148.10/gate.php", "45.9.0.0/16", True),
    ("domain", "evil.com", "0.0.0.0/1", False),
])
def test_in_cidr(t: str, v: str, cidr: str, expected: bool) -> None:
    assert match(leaf("value", "in_cidr", cidr), ioc(t, v)) is expected


# ---------------------------------------------------------- domain suffix ---

@pytest.mark.parametrize(("t", "v", "suffix", "expected"), [
    ("domain", "evil.com", "evil.com", True),
    ("domain", "a.b.evil.com", "evil.com", True),
    ("domain", "notevil.com", "evil.com", False),  # label boundary
    ("domain", "evil.com.attacker.net", "evil.com", False),
    ("url", "https://cdn.evil.com/x", "*.evil.com", True),  # wildcard prefix tolerated
    ("ipv4", "8.8.8.8", "evil.com", False),
])
def test_domain_suffix(t: str, v: str, suffix: str, expected: bool) -> None:
    assert match(leaf("value", "domain_suffix", suffix), ioc(t, v)) is expected


def test_value_ops() -> None:
    v = ioc("url", "https://login-secure.top/Panel/Index.php")
    assert match(leaf("value", "contains", "panel"), v)  # case-insensitive
    assert match(leaf("value", "wildcard", "https://login-*.top/*"), v)
    assert not match(leaf("value", "wildcard", "https://login-?.top/*"), v)
    assert match(leaf("value", "regex", r"^https?://(login|secure)-"), v)
    assert match(leaf("value", "equals", "hxxps://login-secure[.]top/Panel/Index.php"), v)  # normalized
    assert match(leaf("value", "in", ["1.1.1.1", "https://login-secure.top/Panel/Index.php"]), v)


def test_none_values_and_not() -> None:
    d = ioc("domain", "evil.com")  # no port
    assert not match(leaf("port", "eq", 443), d)
    assert match({"op": "not", "child": leaf("port", "eq", 443)}, d)  # NOT(missing) is true, like SQL COALESCE
    assert not match(leaf("asn", "not_in", ["AS1"]), d)


def test_arrays_numbers_age_tlp() -> None:
    v = ioc("domain", "evil.com", tags=["c2", "Phishing"], malware_families=["LockBit"], actors=["FIN11"],
            sources=["telegram", "crawler"], source_count=2, score=0.9, tlp_rank=4,
            first_seen=NOW - timedelta(days=40), last_seen=NOW - timedelta(days=2))
    assert match(leaf("tags", "has_any", ["PHISHING"]), v)
    assert match(leaf("tags", "has_all", ["c2", "phishing"]), v)
    assert match(leaf("malware_family", "has_any", ["lockbit"]), v)
    assert match(leaf("actor", "has_none", ["apt28"]), v)
    assert match(leaf("source", "has_all", ["telegram", "crawler"]), v)
    assert match(leaf("source_count", "gte", 2), v)
    assert match(leaf("score", "between", [0.8, 1]), v)
    assert match(leaf("first_seen_age_days", "gt", 30), v)
    assert match(leaf("last_seen_age_days", "lte", 7), v)
    assert match(leaf("tlp", "gte", "AMBER"), v)
    assert match(leaf("tlp", "eq", "RED"), v)
    assert not match(leaf("tlp", "lte", "GREEN"), v)


def test_nested_tree() -> None:
    cond = {"op": "and", "children": [
        leaf("type", "in", ["ipv4", "domain"]),
        {"op": "or", "children": [leaf("tags", "has_any", ["c2"]), leaf("score", "gte", 0.95)]},
        {"op": "not", "child": leaf("value", "domain_suffix", "good.org")},
    ]}
    assert match(cond, ioc("domain", "x.evil.com", tags=["c2"]))
    assert not match(cond, ioc("domain", "x.good.org", tags=["c2"]))
    assert not match(cond, ioc("url", "http://evil.com/", tags=["c2"]))


# -------------------------------------------------------------- allowlist ---

def test_allowlist_matchers() -> None:
    entries = [{"kind": "domain_suffix", "value": "archive.org"},
               {"kind": "cidr", "value": "8.8.8.0/24"},
               {"kind": "value", "value": "evil-but-sinkholed.com", "ioc_type": "domain"}]
    allowed = python_any(entries, CTX)
    assert allowed(ioc("domain", "web.archive.org"))
    assert allowed(ioc("url", "https://web.archive.org/web/x"))
    assert allowed(ioc("ipv4", "8.8.8.8"))
    assert allowed(ioc("domain", "evil-but-sinkholed.com"))
    assert not allowed(ioc("domain", "evil.com"))
    assert not allowed(ioc("url", "http://evil-but-sinkholed.com/"))  # value entry is type-scoped


# ------------------------------------------------------------- validation ---

@pytest.mark.parametrize("cond", [
    {"field": "nope", "operator": "eq", "value": 1},
    {"field": "port", "operator": "regex", "value": "x"},
    {"field": "value", "operator": "in_cidr", "value": "not-a-cidr"},
    {"field": "value", "operator": "regex", "value": "(a+)+$"},
    {"field": "value", "operator": "regex", "value": r"(\w+\.)*evil"},
    {"field": "value", "operator": "regex", "value": r"(a)\1"},
    {"field": "value", "operator": "regex", "value": "a" * 300},
    {"field": "value", "operator": "regex", "value": "([a-z]"},
    {"field": "score", "operator": "gt", "value": 5},
    {"field": "score", "operator": "between", "value": [0.9, 0.1]},
    {"field": "type", "operator": "eq", "value": "md5"},
    {"field": "tlp", "operator": "eq", "value": "PURPLE"},
    {"field": "asn", "operator": "eq", "value": "ASX"},
    {"op": "and", "children": []},
    {"op": "xor", "children": [{"field": "port", "operator": "eq", "value": 1}]},
    {"field": "port", "operator": "eq", "value": 1, "evil": "__import__('os')"},
    "not an object",
])
def test_invalid_conditions_rejected(cond: Any) -> None:
    with pytest.raises(ConditionError):
        parse_condition(cond)


def test_bounded_regex_allowed() -> None:
    parse_condition(leaf("value", "regex", r"^(\d{1,3}\.){3}\d{1,3}$"))


def test_depth_and_leaf_limits() -> None:
    node: dict[str, Any] = leaf("port", "eq", 1)
    for _ in range(9):
        node = {"op": "not", "child": node}
    with pytest.raises(ConditionError, match="deeper"):
        parse_condition(node)
    with pytest.raises(ConditionError, match="more than"):
        parse_condition({"op": "or", "children": [leaf("port", "eq", i) for i in range(101)]})

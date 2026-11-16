from datetime import UTC, datetime

from anchorage.ioc.normalize import normalize
from anchorage.realtime.index import CidrTrie, IocEntry, LabelTrie, MatcherIndex, RuleEntry
from anchorage.realtime.service import detect, extract_observables
from anchorage.rules.compile import EvalContext, compile_python, ioc_view
from anchorage.rules.schema import parse_condition


def entry(i: int, t: str, v: str, verdict: str = "malicious", sev: str = "high") -> IocEntry:
    n = normalize(t, v, allow_private=True)
    view = ioc_view({"type": n.type, "value_norm": n.value, "ip": n.ip, "net": n.net, "port": n.port,
                     "host": n.host, "tags": ["c2"]})
    return IocEntry(i, n.type, n.value, verdict, sev, {"low": 1, "medium": 2, "high": 3, "critical": 4}[sev], view)


def test_cidr_trie_most_specific_first() -> None:
    t = CidrTrie()
    t.insert("45.9.0.0/16", entry(1, "cidr", "45.9.0.0/16"))
    t.insert("45.9.148.0/24", entry(2, "cidr", "45.9.148.0/24"))
    t.insert("2a00:1450::/32", entry(3, "cidr", "2a00:1450::/32"))
    assert [e.id for e in t.lookup("45.9.148.7")] == [2, 1]
    assert [e.id for e in t.lookup("45.9.1.1")] == [1]
    assert t.lookup("8.8.8.8") == []
    assert [e.id for e in t.lookup("2a00:1450:4001::1")] == [3]


def test_label_trie_suffix() -> None:
    t = LabelTrie()
    t.insert("evil.com", entry(1, "domain", "evil.com"))
    t.insert("cdn.evil.com", entry(2, "domain", "cdn.evil.com"))
    assert [e.id for e in t.lookup("a.cdn.evil.com")] == [2, 1]
    assert [e.id for e in t.lookup("evil.com")] == [1]
    assert t.lookup("notevil.com") == []
    assert t.lookup("com") == []


def _index() -> MatcherIndex:
    idx = MatcherIndex()
    for e in [entry(1, "ipv4", "45.9.148.10"), entry(2, "domain", "evil.com", "suspicious", "medium"),
              entry(3, "cidr", "185.220.101.0/24", "abnormal", "low"), entry(4, "ip:port", "45.9.148.11:4444")]:
        idx.add_ioc(e)
    return idx


def test_extract_observables() -> None:
    obs = extract_observables({"src_ip": "10.0.0.5", "dst_ip": "45.9.148.11", "dst_port": 4444,
                               "query": "WWW.Evil[.]com", "url": "hxxp://x.org/a", "junk": {"x": 1}})
    got = {(n.type, n.value) for _, n in obs}
    assert {("ipv4", "10.0.0.5"), ("ipv4", "45.9.148.11"), ("ip:port", "45.9.148.11:4444"),
            ("domain", "www.evil.com"), ("url", "http://x.org/a")} <= got


def test_detect_exact_cidr_suffix_and_port() -> None:
    idx = _index()
    d = detect(idx, {"dst_ip": "45.9.148.10"})
    assert d[0]["matched_by"] == "exact" and d[0]["verdict"] == "malicious" and d[0]["ioc_id"] == 1
    d = detect(idx, {"dst_ip": "185.220.101.77"})
    assert d[0]["matched_by"] == "cidr" and d[0]["ioc_id"] == 3
    d = detect(idx, {"query": "login.evil.com"})
    assert d[0]["matched_by"] == "domain_suffix" and d[0]["verdict"] == "suspicious"
    d = detect(idx, {"dst_ip": "45.9.148.11", "dst_port": 4444})
    assert any(x["observable_type"] == "ip:port" and x["ioc_id"] == 4 for x in d)
    assert detect(idx, {"dst_ip": "8.8.8.8", "query": "good.org"}) == []
    assert "context" not in str(d)  # only allow-listed context fields stored


def test_rules_run_on_raw_observables_and_allowlist_wins() -> None:
    idx = _index()
    ctx = EvalContext(now=datetime.now(UTC))
    cond = {"op": "and", "children": [{"field": "type", "operator": "eq", "value": "ip:port"},
                                      {"field": "port", "operator": "in", "value": [50050]}]}
    idx.rules.append(RuleEntry(9, "cs teamserver port", 1, "malicious", "critical", 4, 10,
                               compile_python(parse_condition(cond), ctx)))
    d = detect(idx, {"dst_ip": "1.2.3.4", "dst_port": 50050})
    assert d and d[0]["matched_by"] == "rule" and d[0]["rule_ids"] == [9] and d[0]["severity"] == "critical"

    allow = compile_python(parse_condition({"field": "value", "operator": "domain_suffix", "value": "evil.com"}), ctx)
    idx.allow = allow
    assert detect(idx, {"query": "login.evil.com"}) == []

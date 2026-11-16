from datetime import UTC, datetime, timedelta

from anchorage.ioc.normalize import normalize
from anchorage.ioc.records import RawIoc, candidate_from, comparable, finalize, merge

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def _cand(source: str, row: str, **kw):  # type: ignore[no-untyped-def]
    raw = RawIoc(source=source, store=source, table="iocs", row_key=row, ioc_type="domain", value="evil.com", **kw)
    return candidate_from(raw, normalize("domain", "evil.com"), "AMBER")


def test_merge_rules() -> None:
    a = _cand("crawler", "1", first_seen=T0, last_seen=T0 + timedelta(days=1), tlp="WHITE", score=0.4,
              tags=["C2", "phishing"], malware_families=["LockBit"], actors=["A"], mitre_ids=["t1486"])
    b = _cand("telegram", "9", first_seen=T0 - timedelta(days=3), last_seen=T0, tlp="RED", score=0.9,
              tags=["c2", "Botnet"], malware_families=["lockbit", "Clop"], actors=["B"])
    m = merge(a, b)
    assert m["sources"] == ["crawler", "telegram"]
    assert m["first_seen"] == T0 - timedelta(days=3)  # min
    assert m["last_seen"] == T0 + timedelta(days=1)  # max
    assert m["tlp"] == "RED"  # strictest
    assert m["score"] == 0.9  # highest
    assert m["tags"] == ["botnet", "c2", "phishing"]  # lowercased union
    assert m["malware_families"] == ["Clop", "LockBit"]  # case-insensitive union
    assert m["actors"] == ["A", "B"]
    assert m["mitre_ids"] == ["T1486"]
    assert {r["k"] for r in m["source_refs"]} == {"crawler/iocs:1", "telegram/iocs:9"}


def test_merge_is_idempotent_and_commutative() -> None:
    a = _cand("crawler", "1", first_seen=T0, last_seen=T0, tlp="GREEN", score=0.3, tags=["x"])
    b = _cand("connector", "2", first_seen=T0, last_seen=T0 + timedelta(hours=2), tlp="AMBER", score=0.5)
    ab, ba = merge(a, b), merge(b, a)
    assert comparable(finalize(dict(ab), 30, T0)) == comparable(finalize(dict(ba), 30, T0))
    assert comparable(finalize(merge(ab, b), 30, T0)) == comparable(finalize(dict(ab), 30, T0))


def test_finalize_expiry_and_status() -> None:
    c = _cand("crawler", "1", first_seen=T0, last_seen=T0)
    row = finalize(dict(c), 30, now=T0 + timedelta(days=10))
    assert row["status"] == "active" and row["expires_at"] == T0 + timedelta(days=30)
    row = finalize(dict(c), 30, now=T0 + timedelta(days=31))
    assert row["status"] == "expired"


def test_demo_flag_cleared_by_real_source() -> None:
    d = _cand("demo:crawler", "1", is_demo=True)
    r = _cand("crawler", "1", is_demo=False)
    assert merge(d, d)["is_demo"] is True
    assert merge(d, r)["is_demo"] is False


def test_row_hash_changes_with_content() -> None:
    raw = RawIoc(source="s", store="s", table="t", row_key="1", ioc_type="domain", value="a.com", tags=["x"])
    h = raw.row_hash()
    raw.tags.append("y")
    assert raw.row_hash() != h

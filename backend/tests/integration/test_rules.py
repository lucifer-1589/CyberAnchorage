"""Rules engine against PostgreSQL: Python/SQL parity, retro pass, precedence, allowlist, API."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from anchorage.core.db import session_scope
from anchorage.demo.fixture import generate_fixture
from anchorage.models import AuditLog, Ioc, IocFlag
from anchorage.rules.compile import EvalContext, compile_python, compile_sql, ioc_view
from anchorage.rules.schema import parse_condition
from anchorage.sources.sqlite_source import SqliteSnapshotSource
from anchorage.sync.service import SyncService


async def _load_demo(tmp_path: Path, count: int = 600) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=count, seed=7)
    run = await SyncService(lambda: [SqliteSnapshotSource(root, prefix="demo:", is_demo=True)]).run("manual")
    assert run.status == "success", run.errors


def L(field: str, op: str, value: Any) -> dict[str, Any]:
    return {"field": field, "operator": op, "value": value}


PARITY_CASES: list[dict[str, Any]] = [
    L("type", "in", ["ipv4", "ip:port"]),
    L("type", "neq", "domain"),
    L("value", "in_cidr", "185.0.0.0/8"),
    L("value", "in_cidr", "45.0.0.0/7"),
    L("value", "domain_suffix", "top"),
    L("value", "contains", "login"),
    L("value", "starts_with", "https://"),
    L("value", "ends_with", ".php"),
    L("value", "wildcard", "*-cdn*.xyz"),
    L("value", "regex", r"^(secure|verify)-"),
    L("value", "regex", r"\d{4,}"),
    L("source", "has_any", ["demo:telegram"]),
    L("source", "has_all", ["demo:crawler", "demo:connector"]),
    L("source_count", "gte", 2),
    L("score", "between", [0.3, 0.7]),
    L("confidence", "gt", 0.6),
    L("tags", "has_any", ["c2", "ransomware"]),
    L("tags", "has_none", ["phishing"]),
    L("malware_family", "has_any", ["lockbit", "QAKBOT"]),
    L("malware_family", "has_all", ["LockBit", "Clop"]),
    L("actor", "has_any", ["fin11"]),
    L("mitre", "has_any", ["t1486"]),
    L("first_seen_age_days", "gt", 60),
    L("last_seen_age_days", "between", [5, 20]),
    L("tlp", "gte", "AMBER"),
    L("tlp", "in", ["CLEAR", "GREEN"]),
    L("port", "in", [4444, 50050]),
    L("port", "gt", 8000),
    {"op": "not", "child": L("port", "eq", 443)},
    {"op": "not", "child": L("asn", "in", ["AS1234"])},
    L("asn", "not_in", ["AS1234"]),
    {"op": "and", "children": [L("type", "eq", "domain"),
                               {"op": "or", "children": [L("tags", "has_any", ["c2"]), L("score", "gte", 0.8)]},
                               {"op": "not", "child": L("value", "domain_suffix", "xyz")}]},
]


@pytest.mark.parametrize("cond", PARITY_CASES, ids=lambda c: str(c)[:60])
async def test_python_sql_parity(db: None, tmp_path: Path, cond: dict[str, Any]) -> None:
    await _load_demo(tmp_path, count=500)
    node = parse_condition(cond)
    ctx = EvalContext(now=datetime.now(UTC))
    async with session_scope() as s:
        sql_ids = set((await s.execute(select(Ioc.id).where(compile_sql(node, ctx)))).scalars())
        all_iocs = (await s.execute(select(Ioc))).scalars().all()
    pred = compile_python(node, ctx)
    py_ids = {i.id for i in all_iocs if pred(ioc_view(i))}
    assert py_ids == sql_ids, f"python-only={sorted(py_ids - sql_ids)[:5]} sql-only={sorted(sql_ids - py_ids)[:5]}"


async def test_rule_lifecycle_api(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                  tmp_path: Path) -> None:
    await _load_demo(tmp_path)
    analyst, viewer = auth_headers["analyst"], auth_headers["viewer"]
    cond = {"op": "and", "children": [L("type", "in", ["ipv4", "ip:port"]), L("score", "gte", 0.5)]}

    dry = (await client.post("/api/rules/dry-run", json={"condition": cond}, headers=viewer)).json()
    assert dry["count"] > 0 and 0 < len(dry["samples"]) <= 20
    assert "[.]" in dry["samples"][0]["value"]  # defanged by default

    body = {"name": "High-score IPs", "verdict": "suspicious", "severity": "medium", "condition": cond}
    assert (await client.post("/api/rules", json=body, headers=viewer)).status_code == 403
    r = await client.post("/api/rules", json=body, headers=analyst)
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["match_count"] == dry["count"]

    flags = (await client.get("/api/flags", params={"rule_id": rule["id"], "limit": 500}, headers=viewer)).json()
    assert flags["total"] == dry["count"]

    # update → version 2, flags follow the new condition
    body2 = body | {"condition": L("type", "eq", "ipv4"), "change_note": "narrow"}
    r2 = (await client.put(f"/api/rules/{rule['id']}", json=body2, headers=analyst)).json()
    assert r2["version"] == 2
    versions = (await client.get(f"/api/rules/{rule['id']}/versions", headers=viewer)).json()
    assert [v["version"] for v in versions] == [2, 1] and versions[0]["change_note"] == "narrow"
    async with session_scope() as s:
        n_ipv4_active = await s.scalar(select(func.count()).select_from(Ioc).where(
            Ioc.type == "ipv4", Ioc.status == "active", Ioc.allowlisted.is_(False)))
        n_flags = await s.scalar(select(func.count()).select_from(IocFlag).where(IocFlag.rule_id == rule["id"]))
    assert n_flags == n_ipv4_active

    # restore v1
    r3 = (await client.post(f"/api/rules/{rule['id']}/restore/1", headers=analyst)).json()
    assert r3["version"] == 3 and r3["condition"] == cond

    # disable removes flags; enable restores them
    await client.post(f"/api/rules/{rule['id']}/toggle", json={"enabled": False}, headers=analyst)
    assert (await client.get("/api/flags", params={"rule_id": rule["id"]}, headers=viewer)).json()["total"] == 0
    await client.post(f"/api/rules/{rule['id']}/toggle", json={"enabled": True}, headers=analyst)
    assert (await client.get("/api/flags", params={"rule_id": rule["id"]}, headers=viewer)).json()["total"] > 0

    assert (await client.delete(f"/api/rules/{rule['id']}", headers=analyst)).status_code == 204
    assert (await client.get(f"/api/rules/{rule['id']}", headers=viewer)).status_code == 404
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(IocFlag)) == 0
        assert await s.scalar(select(func.count()).select_from(Ioc).where(Ioc.verdict.is_not(None))) == 0
        actions = set((await s.execute(select(AuditLog.action))).scalars())
    assert {"rule.create", "rule.update", "rule.delete"} <= actions


async def test_invalid_rule_payloads_rejected(client: AsyncClient, auth_headers: dict[str, dict[str, str]]) -> None:
    h = auth_headers["analyst"]
    bad = {"name": "x", "verdict": "malicious", "severity": "high",
           "condition": L("value", "regex", "(a+)+$")}
    assert (await client.post("/api/rules", json=bad, headers=h)).status_code == 422
    bad2 = bad | {"verdict": "evil", "condition": L("port", "eq", 1)}
    assert (await client.post("/api/rules", json=bad2, headers=h)).status_code == 422
    r = await client.post("/api/rules/dry-run", json={"condition": L("nope", "eq", 1)}, headers=h)
    assert r.status_code == 422


async def test_highest_severity_wins_and_all_matches_recorded(client: AsyncClient,
                                                              auth_headers: dict[str, dict[str, str]],
                                                              tmp_path: Path) -> None:
    await _load_demo(tmp_path)
    h = auth_headers["analyst"]
    base = L("type", "eq", "ipv4")
    for name, verdict, sev in [("low-mal", "malicious", "low"), ("crit-abn", "abnormal", "critical"),
                               ("high-sus", "suspicious", "high")]:
        r = await client.post("/api/rules", json={"name": name, "verdict": verdict, "severity": sev,
                                                  "condition": base}, headers=h)
        assert r.status_code == 201
    async with session_scope() as s:
        ioc = (await s.execute(select(Ioc).where(Ioc.type == "ipv4", Ioc.status == "active").limit(1))).scalar_one()
        n = await s.scalar(select(func.count()).select_from(IocFlag).where(IocFlag.ioc_id == ioc.id))
    assert n == 3
    assert (ioc.verdict, ioc.severity) == ("abnormal", "critical")


async def test_allowlisted_ioc_is_never_flagged(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                                tmp_path: Path) -> None:
    await _load_demo(tmp_path)
    h = auth_headers["analyst"]
    async with session_scope() as s:
        target = (await s.execute(select(Ioc).where(Ioc.type == "domain", Ioc.status == "active")
                                  .limit(1))).scalar_one()
    await client.post("/api/rules", json={"name": "all domains", "verdict": "malicious", "severity": "critical",
                                          "condition": L("type", "eq", "domain")}, headers=h)
    async with session_scope() as s:
        assert (await s.get(Ioc, target.id)).verdict == "malicious"  # type: ignore[union-attr]

    prev = (await client.post("/api/allowlist/preview", json={"kind": "domain_suffix", "value": target.value_norm},
                              headers=h)).json()
    assert prev["currently_flagged"] >= 1
    r = await client.post("/api/allowlist", json={"kind": "domain_suffix", "value": target.value_norm,
                                                  "reason": "sinkhole"}, headers=h)
    assert r.status_code == 201
    entry_id = r.json()["id"]

    async def flagged() -> tuple[int, Any]:
        async with session_scope() as s:
            cnt = await s.scalar(select(func.count()).select_from(IocFlag).where(IocFlag.ioc_id == target.id))
            return int(cnt or 0), (await s.get(Ioc, target.id)).verdict  # type: ignore[union-attr]

    assert await flagged() == (0, None)
    # a new matching rule, a full re-evaluation and a sync all keep it unflagged
    await client.post("/api/rules", json={"name": "exact", "verdict": "malicious", "severity": "critical",
                                          "condition": L("value", "equals", target.value_norm)}, headers=h)
    await client.post("/api/rules/reevaluate", headers=h)
    assert await flagged() == (0, None)
    await SyncService(lambda: [SqliteSnapshotSource(tmp_path / "cti", prefix="demo:", is_demo=True)]).run("daily")
    assert await flagged() == (0, None)

    # removing the entry lets rules flag it again
    assert (await client.delete(f"/api/allowlist/{entry_id}", headers=h)).status_code == 204
    cnt, verdict = await flagged()
    assert cnt == 2 and verdict == "malicious"
    async with session_scope() as s:
        actions = set((await s.execute(select(AuditLog.action))).scalars())
    assert {"allowlist.create", "allowlist.delete"} <= actions


async def test_sync_reevaluates_rules(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                      tmp_path: Path) -> None:
    h = auth_headers["analyst"]
    await client.post("/api/rules", json={"name": "c2 ports", "verdict": "malicious", "severity": "high",
                                          "condition": L("type", "eq", "ip:port")}, headers=h)
    await _load_demo(tmp_path)  # sync runs after the rule exists
    async with session_scope() as s:
        flagged = await s.scalar(select(func.count()).select_from(Ioc).where(Ioc.verdict == "malicious"))
    assert flagged and flagged > 0

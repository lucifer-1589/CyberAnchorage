"""IOC explorer, overview, sync API, audit, websocket and the detection seam."""

from __future__ import annotations

from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select

from anchorage.core.db import session_scope
from anchorage.demo.fixture import generate_fixture
from anchorage.models import AuditLog, Ioc, SyncRun
from anchorage.realtime.service import rebuild_index
from anchorage.sources.sqlite_source import SqliteSnapshotSource
from anchorage.sync.service import SyncService


async def _load(tmp_path: Path) -> None:
    root = tmp_path / "cti"
    generate_fixture(root, count=400, seed=11)
    await SyncService(lambda: [SqliteSnapshotSource(root, prefix="demo:", is_demo=True)]).run("manual")


async def test_ioc_list_filters_detail_and_reveal(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                                  tmp_path: Path) -> None:
    await _load(tmp_path)
    v, a = auth_headers["viewer"], auth_headers["analyst"]
    page = (await client.get("/api/iocs", params={"limit": 50}, headers=v)).json()
    assert page["total"] > 50 and len(page["items"]) == 50
    assert all(i["status"] == "active" for i in page["items"])
    assert all("[.]" in i["value"] for i in page["items"] if i["type"] in ("domain", "ipv4", "url"))

    ips = (await client.get("/api/iocs", params=[("type", "ipv4"), ("type", "cidr"), ("sort", "score")],
                            headers=v)).json()
    assert ips["items"] and {i["type"] for i in ips["items"]} <= {"ipv4", "cidr"}
    scores = [i["score"] for i in ips["items"]]
    assert scores == sorted(scores, reverse=True)

    target = page["items"][0]
    refanged = target["value"].replace("[.]", ".").replace("hxxp", "http")
    found = (await client.get("/api/iocs", params={"q": target["value"]}, headers=v)).json()  # defanged search works
    assert any(i["id"] == target["id"] for i in found["items"])

    allst = (await client.get("/api/iocs", params={"status": "all", "limit": 1}, headers=v)).json()
    assert allst["total"] >= page["total"]

    facets = (await client.get("/api/iocs/facets", headers=v)).json()
    assert {f["key"] for f in facets["type"]} and facets["source"]

    detail = (await client.get(f"/api/iocs/{target['id']}", headers=v)).json()
    assert detail["ioc"]["id"] == target["id"] and detail["source_refs"]
    for ref in detail["source_refs"]:
        assert "http://" not in (ref.get("url") or "") and "https://" not in (ref.get("url") or "")

    assert (await client.post(f"/api/iocs/{target['id']}/reveal", headers=v)).status_code == 403
    raw = (await client.post(f"/api/iocs/{target['id']}/reveal", headers=a)).json()
    assert raw["value"] == refanged
    async with session_scope() as s:
        assert "ioc.reveal" in set((await s.execute(select(AuditLog.action))).scalars())

    sr = (await client.get("/api/search", params={"q": refanged}, headers=v)).json()
    assert sr["iocs"][0]["id"] == target["id"]

    view = await client.post("/api/views", json={"name": "IPs", "filters": {"type": ["ipv4"]}}, headers=v)
    assert view.status_code == 201
    assert [x["name"] for x in (await client.get("/api/views", headers=v)).json()] == ["IPs"]


async def test_overview_and_sync_api(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                     tmp_path: Path) -> None:
    await _load(tmp_path)
    v, a = auth_headers["viewer"], auth_headers["analyst"]
    ov = (await client.get("/api/stats/overview", headers=v)).json()
    assert ov["totals"]["active"] > 0 and ov["totals"]["demo"] > 0
    assert len(ov["timeline"]) == 30 and sum(d["ingested"] for d in ov["timeline"]) == ov["totals"]["all"]
    assert ov["sync"]["last_run"]["status"] == "success"

    st = (await client.get("/api/sync/status", headers=v)).json()
    assert "worker" in st and isinstance(st["cursors"], list)
    runs = (await client.get("/api/sync/runs", headers=v)).json()
    assert runs["total"] == 1

    assert (await client.post("/api/sync/run", json={"kind": "manual"}, headers=v)).status_code == 403
    r = await client.post("/api/sync/run", json={"kind": "daily"}, headers=a)
    assert r.status_code == 202 and r.json()["status"] == "queued" and r.json()["mode"] == "full"
    async with session_scope() as s:
        assert (await s.execute(select(SyncRun).where(SyncRun.status == "queued"))).scalar_one()

    assert (await client.get("/api/audit", headers=v)).status_code == 403
    assert (await client.get("/api/audit", headers=a)).status_code == 200


async def test_synthetic_event_creates_detection(client: AsyncClient, auth_headers: dict[str, dict[str, str]],
                                                 tmp_path: Path) -> None:
    await _load(tmp_path)
    a, v = auth_headers["analyst"], auth_headers["viewer"]
    async with session_scope() as s:
        ip = (await s.execute(select(Ioc).where(Ioc.type == "ipv4", Ioc.status == "active").limit(1))).scalar_one()
        dom = (await s.execute(select(Ioc).where(Ioc.type == "domain", Ioc.status == "active").limit(1))).scalar_one()
    await client.post("/api/rules", json={"name": "bad ip", "verdict": "malicious", "severity": "critical",
                                          "condition": {"field": "value", "operator": "equals",
                                                        "value": ip.value_norm}}, headers=a)
    await client.post("/api/rules", json={"name": "bad dom", "verdict": "malicious", "severity": "high",
                                          "condition": {"field": "value", "operator": "equals",
                                                        "value": dom.value_norm}}, headers=a)
    await rebuild_index()

    ev = {"ts": "2026-11-16T10:00:00Z", "sensor": "fw-1", "src_ip": "10.1.1.5", "dst_ip": ip.value_norm,
          "dst_port": 443, "payload": "SHOULD NOT BE STORED"}
    assert (await client.post("/api/events/ingest", json={"events": [ev]}, headers=v)).status_code == 403
    r = (await client.post("/api/events/ingest", json={"source": "test", "events": [ev]}, headers=a)).json()
    assert r["processed"] == 1
    (det,) = [d for d in r["detections"] if d["ioc_id"] == ip.id]
    assert det["verdict"] == "malicious" and det["severity"] == "critical" and det["matched_by"] == "exact"
    assert "SHOULD NOT BE STORED" not in str(det["event"])

    # subdomain of a flagged domain → suffix match
    r2 = (await client.post("/api/events/ingest", json={"events": [{"query": f"cdn.{dom.value_norm}"}]},
                            headers=a)).json()
    assert r2["detections"][0]["matched_by"] == "domain_suffix"

    # benign event → nothing
    r3 = (await client.post("/api/events/ingest", json={"events": [{"dst_ip": "9.9.9.9"}]}, headers=a)).json()
    assert r3["detections"] == []

    # allowlisting the IOC suppresses future detections
    await client.post("/api/allowlist", json={"kind": "value", "value": ip.value_norm, "ioc_type": "ipv4"},
                      headers=a)
    await rebuild_index()
    r4 = (await client.post("/api/events/ingest", json={"events": [ev]}, headers=a)).json()
    assert r4["detections"] == []

    lst = (await client.get("/api/detections", headers=v)).json()
    assert lst["total"] == 2 and all(not d["is_simulated"] for d in lst["items"])
    assert (await client.get("/api/realtime/status", headers=v)).json()["simulator"] is False


async def test_ingest_token(client: AsyncClient, db: None, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from anchorage.core.config import get_settings

    monkeypatch.setattr(get_settings(), "ingest_token", "s3cret-token-value")
    body = {"events": [{"dst_ip": "9.9.9.9"}]}
    assert (await client.post("/api/events/ingest", json=body, headers={"X-Ingest-Token": "nope"})).status_code == 401
    ok = await client.post("/api/events/ingest", json=body, headers={"X-Ingest-Token": "s3cret-token-value"})
    assert ok.status_code == 200


def test_websocket_rejects_bad_token() -> None:
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from anchorage.main import create_app

    with TestClient(create_app(with_lifespan=False)) as tc:
        try:
            with tc.websocket_connect("/api/ws?token=bad") as ws:
                ws.receive_json()
        except WebSocketDisconnect as exc:
            assert exc.code == 4401
        else:
            raise AssertionError("bad token accepted")

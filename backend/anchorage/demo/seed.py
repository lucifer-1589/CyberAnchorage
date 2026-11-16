"""`make seed-demo`: fixture CTI → sync → sample rules."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select

from anchorage.core.config import get_settings
from anchorage.core.db import session_scope
from anchorage.demo.fixture import generate_fixture

DEMO_RULES: list[dict[str, Any]] = [
    {
        "name": "Ransomware & loader C2 infrastructure",
        "description": "Network IOCs attributed to ransomware or loader families.",
        "verdict": "malicious", "severity": "critical", "priority": 10,
        "condition": {"op": "and", "children": [
            {"field": "malware_family", "operator": "has_any",
             "value": ["LockBit", "Clop", "BlackCat", "Qakbot", "Emotet"]},
            {"field": "type", "operator": "in", "value": ["ipv4", "ip:port", "domain", "url"]},
        ]},
    },
    {
        "name": "Corroborated by multiple sources",
        "description": "Seen in two or more CTI sources with a decent score.",
        "verdict": "suspicious", "severity": "high", "priority": 20,
        "condition": {"op": "and", "children": [
            {"field": "source_count", "operator": "gte", "value": 2},
            {"field": "score", "operator": "gte", "value": 0.5},
        ]},
    },
    {
        "name": "Credential-phishing style hostnames",
        "description": "Hostnames that start with login/secure/verify/account.",
        "verdict": "suspicious", "severity": "medium", "priority": 30,
        "condition": {"op": "or", "children": [
            {"field": "value", "operator": "regex", "value": r"^(https?://)?(login|secure|verify|account)-"},
            {"field": "tags", "operator": "has_any", "value": ["phishing"]},
        ]},
    },
    {
        "name": "Fresh onion services",
        "description": "Onion services seen in the last 14 days.",
        "verdict": "abnormal", "severity": "low", "priority": 50,
        "condition": {"op": "and", "children": [
            {"field": "type", "operator": "eq", "value": "onion"},
            {"field": "last_seen_age_days", "operator": "lte", "value": 14},
        ]},
    },
    {
        "name": "C2 ports on raw IP sockets",
        "description": "ip:port IOCs on common C2 framework ports.",
        "verdict": "malicious", "severity": "high", "priority": 15,
        "condition": {"op": "and", "children": [
            {"field": "type", "operator": "eq", "value": "ip:port"},
            {"field": "port", "operator": "in", "value": [4444, 50050, 8443]},
        ]},
    },
]


async def seed_demo(count: int = 1500, sync: bool = True) -> dict[str, Any]:
    s = get_settings()
    summary = generate_fixture(Path(s.demo_cti_dir), count=count, forbid_inside=Path(s.cti_data_dir))
    print(f"demo fixture written to {summary.path}: {summary.rows}")
    out: dict[str, Any] = {"fixture": summary.rows}
    await _ensure_rules()
    if sync:
        from anchorage.sync.service import SyncService

        run = await SyncService().run("manual", triggered_by="seed-demo")
        out["sync"] = {"status": run.status, "new": run.new_count, "updated": run.updated_count,
                       "rejected": run.rejected_count, "skipped": run.skipped_count, "flagged": run.flagged_count}
        print(f"sync: {out['sync']}")
    return out


async def _ensure_rules() -> None:
    try:
        from anchorage.rules.service import create_rule
    except ImportError:
        return
    from anchorage.models import Rule

    async with session_scope() as session:
        existing = set((await session.execute(select(Rule.name).where(Rule.deleted_at.is_(None)))).scalars())
        for spec in DEMO_RULES:
            if spec["name"] not in existing:
                await create_rule(session, dict(spec, is_demo=True), actor=None, evaluate=False)
    print("demo rules ready")

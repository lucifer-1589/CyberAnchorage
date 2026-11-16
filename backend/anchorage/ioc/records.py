"""Source records and the merge semantics (one implementation, used everywhere).

Merge rules (PLAN.md §4): union sources/tags/families/actors/MITRE, min first_seen,
max last_seen, strictest TLP, highest score/confidence, source refs keyed by source row.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from anchorage.ioc.normalize import Normalized
from anchorage.models.enums import TLP_RANK, norm_tlp

MAX_REFS = 100
MAX_LIST = 64


@dataclass(slots=True)
class RawIoc:
    """One row from a CTI store, before normalization. Never carries raw page content."""

    source: str  # logical source name shown in UI, e.g. "telegram", "demo:crawler"
    store: str  # store key, e.g. "telegram"
    table: str
    row_key: str
    ioc_type: str
    value: str
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    tlp: str | None = None
    score: float | None = None
    confidence: float | None = None
    tags: list[str] = field(default_factory=list)
    malware_families: list[str] = field(default_factory=list)
    actors: list[str] = field(default_factory=list)
    mitre_ids: list[str] = field(default_factory=list)
    ref: dict[str, Any] = field(default_factory=dict)  # title/url/channel/message ids only
    is_demo: bool = False
    cursor_last_seen: str | None = None  # raw text value of the source's last_seen column

    @property
    def source_key(self) -> str:
        return f"{self.source}/{self.table}"

    def row_hash(self) -> str:
        payload = [self.ioc_type, self.value, _iso(self.first_seen), _iso(self.last_seen), self.tlp,
                   self.score, self.confidence, sorted(self.tags), sorted(self.malware_families),
                   sorted(self.actors), sorted(self.mitre_ids), self.ref]
        return hashlib.sha1(json.dumps(payload, default=str, sort_keys=True).encode(),
                            usedforsecurity=False).hexdigest()


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _clean_list(values: list[str] | None, lower: bool = False) -> list[str]:
    out: dict[str, str] = {}
    for v in values or []:
        if v is None:
            continue
        s = str(v).strip()
        if not s or len(s) > 80:
            continue
        key = s.lower()
        if key not in out:
            out[key] = key if lower else s
    return sorted(out.values(), key=str.lower)[:MAX_LIST]


def _union(a: list[str], b: list[str], lower: bool = False) -> list[str]:
    return _clean_list([*(a or []), *(b or [])], lower=lower)


def _min_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    return min((d for d in (a, b) if d), default=None)


def _max_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    return max((d for d in (a, b) if d), default=None)


def _strictest_tlp(a: str | None, b: str | None) -> str:
    cands = [t for t in (a, b) if t]
    if not cands:
        return "AMBER"
    return max(cands, key=lambda t: TLP_RANK.get(t, 2))


def make_ref(raw: RawIoc) -> dict[str, Any]:
    ref = {"k": f"{raw.source_key}:{raw.row_key}", "source": raw.source, "store": raw.store,
           "table": raw.table, "row": raw.row_key,
           "first_seen": _iso(raw.first_seen), "last_seen": _iso(raw.last_seen)}
    ref.update({k: v for k, v in raw.ref.items() if v not in (None, "")})
    return ref


def merge_refs(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {r["k"]: r for r in existing or [] if "k" in r}
    for r in incoming:
        by_key[r["k"]] = r  # newer observation of the same source row wins
    refs = sorted(by_key.values(), key=lambda r: (r.get("last_seen") or "", r["k"]), reverse=True)
    return refs[:MAX_REFS]


def candidate_from(raw: RawIoc, n: Normalized, default_tlp: str) -> dict[str, Any]:
    """Build an IOC row dict (same keys as the `iocs` columns we manage)."""
    now = datetime.now(UTC)
    first = raw.first_seen or raw.last_seen or now
    last = raw.last_seen or raw.first_seen or now
    tlp = norm_tlp(raw.tlp, default_tlp)
    return {
        "type": n.type,
        "value_norm": n.value,
        "value_raw": raw.value[:2048],
        "ip": n.ip, "net": n.net, "port": n.port, "asn": n.asn,
        "host": n.host, "host_rev": n.host_rev,
        "sources": [raw.source],
        "source_refs": [make_ref(raw)],
        "first_seen": min(first, last),
        "last_seen": max(first, last),
        "tlp": tlp,
        "score": round(max(0.0, min(1.0, raw.score if raw.score is not None else 0.0)), 4),
        "confidence": round(max(0.0, min(1.0, raw.confidence if raw.confidence is not None else 0.0)), 4),
        "tags": _clean_list([*raw.tags, *n.extra_tags], lower=True),
        "malware_families": _clean_list(raw.malware_families),
        "actors": _clean_list(raw.actors),
        "mitre_ids": _clean_list([m.upper() for m in raw.mitre_ids]),
        "is_demo": raw.is_demo,
    }


MERGE_FIELDS = ("sources", "source_refs", "first_seen", "last_seen", "tlp", "score", "confidence", "tags",
                "malware_families", "actors", "mitre_ids", "is_demo")


def merge(base: dict[str, Any], inc: dict[str, Any]) -> dict[str, Any]:
    """Merge `inc` into `base` (pure; returns a new dict). Commutative & idempotent."""
    out = dict(base)
    out["sources"] = _union(base.get("sources", []), inc.get("sources", []))
    out["source_refs"] = merge_refs(base.get("source_refs", []), inc.get("source_refs", []))
    out["first_seen"] = _min_dt(base.get("first_seen"), inc.get("first_seen"))
    out["last_seen"] = _max_dt(base.get("last_seen"), inc.get("last_seen"))
    out["tlp"] = _strictest_tlp(base.get("tlp"), inc.get("tlp"))
    out["score"] = max(base.get("score") or 0.0, inc.get("score") or 0.0)
    out["confidence"] = max(base.get("confidence") or 0.0, inc.get("confidence") or 0.0)
    out["tags"] = _union(base.get("tags", []), inc.get("tags", []), lower=True)
    out["malware_families"] = _union(base.get("malware_families", []), inc.get("malware_families", []))
    out["actors"] = _union(base.get("actors", []), inc.get("actors", []))
    out["mitre_ids"] = _union(base.get("mitre_ids", []), inc.get("mitre_ids", []))
    # demo flag only sticks while *every* contributing source is demo
    out["is_demo"] = bool(base.get("is_demo", inc.get("is_demo"))) and bool(inc.get("is_demo", False))
    for k in ("value_raw", "ip", "net", "port", "asn", "host", "host_rev"):
        if out.get(k) is None and inc.get(k) is not None:
            out[k] = inc[k]
    return out


def finalize(row: dict[str, Any], expiry_days: int, now: datetime | None = None) -> dict[str, Any]:
    """Derived columns: counts, ranks, expiry and status."""
    now = now or datetime.now(UTC)
    row["source_count"] = len(row.get("sources") or [])
    row["tlp_rank"] = TLP_RANK.get(row["tlp"], 2)
    last = row.get("last_seen") or now
    row["expires_at"] = last + timedelta(days=expiry_days)
    row["status"] = "active" if row["expires_at"] > now else "expired"
    return row


def comparable(row: dict[str, Any]) -> tuple[Any, ...]:
    """Projection used to decide updated vs unchanged."""
    def norm(v: Any) -> Any:
        if isinstance(v, datetime):
            return v.astimezone(UTC).replace(microsecond=0).isoformat()
        if isinstance(v, float):
            return round(v, 4)
        if isinstance(v, list):
            return json.dumps(v, sort_keys=True, default=str)
        return v

    return tuple(norm(row.get(k)) for k in (*MERGE_FIELDS, "status"))

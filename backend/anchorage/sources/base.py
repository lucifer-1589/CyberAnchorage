"""IocSource adapter interface."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from anchorage.ioc.records import RawIoc


@dataclass(slots=True)
class Cursor:
    max_rowid: int = 0
    max_last_seen: str | None = None


@dataclass(slots=True)
class SourceRow:
    rowid: int
    last_seen_raw: str | None
    raw: RawIoc


@dataclass(slots=True)
class TableHandle:
    source: str  # logical source name, e.g. "telegram" / "demo:telegram"
    store: str
    table: str
    supports_cursor: bool
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def source_key(self) -> str:
        return f"{self.source}/{self.table}"


@dataclass(slots=True)
class SourceHealth:
    source: str
    store: str
    path: str
    ok: bool
    detail: str = ""
    rows: int | None = None
    size_bytes: int | None = None
    modified_at: str | None = None
    is_demo: bool = False


class IocSource(Protocol):
    name: str
    is_demo: bool

    async def prepare(self) -> list[TableHandle]:
        """Snapshot / connect; return the readable tables."""
        ...

    async def fetch(self, table: TableHandle, after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
        """Rows with rowid > after_rowid (and matching `cursor` when given), ordered by rowid."""
        ...

    async def skipped_count(self, table: TableHandle) -> int:
        """Rows of out-of-scope types (reporting only)."""
        ...

    async def health(self) -> list[SourceHealth]: ...

    async def close(self) -> None: ...


# ----------------------------------------------------------------- helpers ---

def parse_dt(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    s = str(value).strip().replace("Z", "+00:00")
    for candidate in (s, s.replace(" ", "T", 1)):
        try:
            d = datetime.fromisoformat(candidate)
            return d if d.tzinfo else d.replace(tzinfo=UTC)
        except ValueError:
            continue
    try:
        ts = float(s)
        if ts > 1e12:
            ts /= 1000
        return datetime.fromtimestamp(ts, UTC)
    except ValueError:
        return None


def split_csv(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    s = str(value).strip()
    if s.startswith("["):
        try:
            data = json.loads(s)
            if isinstance(data, list):
                return [str(v).strip() for v in data if str(v).strip()]
        except ValueError:
            pass
    return [p.strip() for p in s.replace(";", ",").replace("|", ",").split(",") if p.strip()]


CONFIDENCE_MAP = {"low": 0.3, "medium": 0.6, "med": 0.6, "high": 0.85, "critical": 0.95, "confirmed": 0.95}
SEVERITY_SCORE = {"low": 0.25, "medium": 0.5, "high": 0.75, "critical": 0.9}


def conf_to_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        f = float(value)
        return f / 100 if f > 1 else f
    except (TypeError, ValueError):
        return CONFIDENCE_MAP.get(str(value).strip().lower())


def structured_from_json(raw_json: Any) -> dict[str, list[str]]:
    """Pull only structured attribution keys from a CTI raw_json blob; the blob itself is discarded."""
    out: dict[str, list[str]] = {"malware": [], "actors": [], "mitre": [], "tags": []}
    if not raw_json or not isinstance(raw_json, str) or len(raw_json) > 200_000:
        return out
    try:
        data = json.loads(raw_json)
    except ValueError:
        return out
    if not isinstance(data, dict):
        return out
    keys = {
        "malware": ("malware_family", "malware_families", "malware", "family", "families"),
        "actors": ("actor", "actors", "threat_actor", "apt", "group", "intrusion_set"),
        "mitre": ("mitre", "mitre_ids", "ttps", "attack_ids", "techniques"),
        "tags": ("tags", "labels"),
    }
    for target, names in keys.items():
        for name in names:
            v = data.get(name)
            if isinstance(v, str):
                out[target].extend(split_csv(v))
            elif isinstance(v, list):
                out[target].extend(str(x) for x in v if isinstance(x, str | int))
    out["mitre"] = [m for m in out["mitre"] if m.upper().startswith(("T", "TA"))]
    return out

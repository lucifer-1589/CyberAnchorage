"""HttpSource — reads the CTI's GET /api/iocs with a bearer token. Disabled by default.

Only GET /api/iocs is ever called. Command-executing routes (/api/tg-pty/* etc.) are refused by
construction: the path is a constant and `_guard` rejects anything else.
"""

from __future__ import annotations

from typing import Any

import httpx

from anchorage.ioc.records import RawIoc
from anchorage.sources.base import Cursor, SourceHealth, SourceRow, TableHandle, conf_to_float, parse_dt, split_csv

API_PATH = "/api/iocs"
_ALLOWED_PATHS = frozenset({API_PATH})


def _guard(path: str) -> str:
    if path not in _ALLOWED_PATHS:
        raise PermissionError(f"HttpSource may not call {path}")
    return path


class HttpSource:
    def __init__(self, base_url: str, token: str, *, name: str = "cti-http", timeout: float = 30.0,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.name = name
        self.is_demo = False
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout, transport=transport,
            headers={"Authorization": f"Bearer {token}"} if token else {}, follow_redirects=False)
        self.errors: list[dict[str, str]] = []

    async def prepare(self) -> list[TableHandle]:
        return [TableHandle(source="cti-http", store="http", table="api_iocs", supports_cursor=False)]

    async def fetch(self, table: TableHandle, after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
        # `after_rowid` doubles as the offset (HTTP API has no stable rowid); hash diff decides changes.
        resp = await self._client.get(_guard(API_PATH), params={"limit": min(limit, 5000), "offset": after_rowid})
        resp.raise_for_status()
        items: list[dict[str, Any]] = resp.json().get("iocs", [])
        out = []
        for i, row in enumerate(items, start=1):
            score = row.get("score")
            raw = RawIoc(
                source=f"cti-http:{row.get('origin') or 'cti'}", store="http", table="api_iocs",
                row_key=f"{row.get('origin', 'cti')}:{row.get('id', after_rowid + i)}",
                ioc_type=row.get("ioc_type") or "", value=row.get("value") or "",
                first_seen=parse_dt(row.get("first_seen")), last_seen=parse_dt(row.get("last_seen")),
                tlp=row.get("tlp"), score=float(score) / 100 if score is not None else None,
                confidence=conf_to_float(row.get("confidence")), tags=split_csv(row.get("tags")),
                ref={"title": row.get("source_title"), "url": row.get("source_url")},
                cursor_last_seen=row.get("last_seen"),
            )
            out.append(SourceRow(after_rowid + i, row.get("last_seen"), raw))
        return out

    async def skipped_count(self, table: TableHandle) -> int:
        return 0

    async def health(self) -> list[SourceHealth]:
        try:
            r = await self._client.get(_guard(API_PATH), params={"limit": 1, "offset": 0})
            ok = r.status_code == 200
            total = r.json().get("total") if ok else None
            return [SourceHealth("cti-http", "http", self.base_url + API_PATH, ok, f"HTTP {r.status_code}", total)]
        except httpx.HTTPError as exc:
            return [SourceHealth("cti-http", "http", self.base_url + API_PATH, False, str(exc))]

    async def close(self) -> None:
        await self._client.aclose()

"""CTI source adapters and the factory that builds the configured set."""

from __future__ import annotations

from pathlib import Path

from anchorage.core.config import Settings, get_settings
from anchorage.sources.base import IocSource
from anchorage.sources.http_source import HttpSource
from anchorage.sources.sqlite_source import SqliteSnapshotSource


def build_sources(settings: Settings | None = None) -> list[IocSource]:
    s = settings or get_settings()
    out: list[IocSource] = []
    if s.cti_source_mode == "sqlite":
        out.append(SqliteSnapshotSource(s.cti_data_dir, name="cti"))
    elif s.cti_source_mode == "http" and s.cti_http_enabled:
        out.append(HttpSource(s.cti_http_base_url, s.cti_http_token))
    if s.demo_data_enabled and Path(s.demo_cti_dir).exists():
        out.append(SqliteSnapshotSource(s.demo_cti_dir, name="demo", prefix="demo:", is_demo=True))
    return out

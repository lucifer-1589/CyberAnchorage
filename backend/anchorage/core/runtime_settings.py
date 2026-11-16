"""Admin-editable runtime settings stored in `app_settings` with typed defaults."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.models import AppSetting


class ExpiryDays(BaseModel):
    ipv4: int = Field(30, ge=1, le=3650)
    ipv6: int = Field(30, ge=1, le=3650)
    cidr: int = Field(30, ge=1, le=3650)
    ip_port: int = Field(30, ge=1, le=3650)
    domain: int = Field(90, ge=1, le=3650)
    url: int = Field(90, ge=1, le=3650)
    onion: int = Field(90, ge=1, le=3650)
    asn: int = Field(180, ge=1, le=3650)
    ja3: int = Field(180, ge=1, le=3650)
    ja3s: int = Field(180, ge=1, le=3650)

    def for_type(self, ioc_type: str) -> int:
        return int(getattr(self, ioc_type.replace(":", "_"), 90))


class RuntimeSettings(BaseModel):
    allow_private_ips: bool = False
    default_tlp: str = "AMBER"
    expiry_days: ExpiryDays = Field(default_factory=ExpiryDays)
    enabled_types: list[str] = Field(
        default_factory=lambda: ["ipv4", "ipv6", "cidr", "domain", "url", "ip:port", "onion", "asn", "ja3", "ja3s"]
    )
    regex_timeout_ms: int = Field(50, ge=5, le=1000)
    retro_statement_timeout_ms: int = Field(60_000, ge=1000, le=600_000)


KEY = "runtime"


async def load_runtime_settings(session: AsyncSession) -> RuntimeSettings:
    row = (await session.execute(select(AppSetting).where(AppSetting.key == KEY))).scalar_one_or_none()
    if row is None or not isinstance(row.value, dict):
        return RuntimeSettings()
    return RuntimeSettings.model_validate(row.value)


async def save_runtime_settings(session: AsyncSession, value: RuntimeSettings) -> dict[str, Any]:
    row = (await session.execute(select(AppSetting).where(AppSetting.key == KEY))).scalar_one_or_none()
    data = value.model_dump()
    if row is None:
        session.add(AppSetting(key=KEY, value=data))
    else:
        row.value = data
    return data

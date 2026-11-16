"""Response schemas shared by routers."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from anchorage.ioc.normalize import defang


class IocOut(BaseModel):
    """IOC as shown in lists. `value` is ALWAYS defanged; raw needs the reveal endpoint."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    value: str = Field(validation_alias="value_norm")
    sources: list[str]
    source_count: int
    first_seen: datetime | None
    last_seen: datetime | None
    tlp: str
    score: float
    confidence: float
    tags: list[str]
    malware_families: list[str]
    actors: list[str]
    mitre_ids: list[str]
    status: str
    expires_at: datetime | None
    allowlisted: bool
    verdict: str | None
    severity: str | None
    port: int | None = None
    asn: int | None = None
    is_demo: bool

    @model_validator(mode="after")
    def _defang(self) -> IocOut:
        self.value = defang(self.value, self.type)
        return self


class Page(BaseModel):
    items: list[Any]
    total: int
    limit: int
    offset: int
    total_is_estimate: bool = False


class RuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    enabled: bool
    priority: int
    verdict: str
    severity: str
    condition: dict[str, Any]
    expires_at: datetime | None
    version: int
    is_demo: bool
    created_at: datetime
    updated_at: datetime
    last_evaluated_at: datetime | None
    match_count: int


class RuleVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    snapshot: dict[str, Any]
    changed_by_email: str | None
    change_note: str
    changed_at: datetime


class AllowlistOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    ioc_type: str | None
    value: str
    reason: str
    expires_at: datetime | None
    created_by_email: str | None
    created_at: datetime

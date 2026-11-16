from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, CIDR, INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from anchorage.core.db import Base


class Ioc(Base):
    __tablename__ = "iocs"
    __table_args__ = (
        UniqueConstraint("type", "value_norm", name="uq_iocs_type_value"),
        Index("ix_iocs_ip_gist", "ip", postgresql_using="gist", postgresql_ops={"ip": "inet_ops"}),
        Index("ix_iocs_net_gist", "net", postgresql_using="gist", postgresql_ops={"net": "inet_ops"}),
        Index("ix_iocs_host_rev", "host_rev", postgresql_ops={"host_rev": "text_pattern_ops"}),
        # ix_iocs_value_trgm (gin_trgm_ops) is created in migration 0001 when pg_trgm exists
        Index("ix_iocs_tags_gin", "tags", postgresql_using="gin"),
        Index("ix_iocs_sources_gin", "sources", postgresql_using="gin"),
        Index("ix_iocs_last_seen", "last_seen"),
        Index("ix_iocs_verdict", "verdict", "severity_rank"),
        Index("ix_iocs_status_type", "status", "type"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    type: Mapped[str] = mapped_column(String(16))
    value_norm: Mapped[str] = mapped_column(Text)
    value_raw: Mapped[str | None] = mapped_column(Text)

    ip: Mapped[str | None] = mapped_column(INET)
    net: Mapped[str | None] = mapped_column(CIDR)
    port: Mapped[int | None] = mapped_column(Integer)
    asn: Mapped[int | None] = mapped_column(BigInteger)
    host: Mapped[str | None] = mapped_column(Text)
    host_rev: Mapped[str | None] = mapped_column(Text)

    sources: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    source_count: Mapped[int] = mapped_column(SmallInteger, default=0)
    source_refs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    first_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tlp: Mapped[str] = mapped_column(String(16), default="AMBER")
    tlp_rank: Mapped[int] = mapped_column(SmallInteger, default=2)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    malware_families: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    actors: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    mitre_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)

    status: Mapped[str] = mapped_column(String(12), default="active")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    allowlisted: Mapped[bool] = mapped_column(Boolean, default=False)
    verdict: Mapped[str | None] = mapped_column(String(16))
    severity: Mapped[str | None] = mapped_column(String(16))
    severity_rank: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IocFlag(Base):
    __tablename__ = "ioc_flags"
    __table_args__ = (UniqueConstraint("ioc_id", "rule_id", name="uq_flags_ioc_rule"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ioc_id: Mapped[int] = mapped_column(ForeignKey("iocs.id", ondelete="CASCADE"), index=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), index=True)
    rule_version: Mapped[int] = mapped_column(Integer)
    verdict: Mapped[str] = mapped_column(String(16))
    severity: Mapped[str] = mapped_column(String(16))
    severity_rank: Mapped[int] = mapped_column(SmallInteger)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

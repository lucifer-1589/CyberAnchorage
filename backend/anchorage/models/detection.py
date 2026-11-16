from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, SmallInteger, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from anchorage.core.db import Base


class Detection(Base):
    __tablename__ = "detections"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    event_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(80))
    event: Mapped[dict[str, Any]] = mapped_column(JSONB)
    observable: Mapped[str] = mapped_column(Text)
    observable_type: Mapped[str] = mapped_column(String(16))
    matched_by: Mapped[str] = mapped_column(String(24))  # exact | cidr | domain_suffix | rule
    ioc_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    rule_ids: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=list)
    verdict: Mapped[str] = mapped_column(String(16))
    severity: Mapped[str] = mapped_column(String(16))
    severity_rank: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=False)

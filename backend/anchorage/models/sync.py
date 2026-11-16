from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from anchorage.core.db import Base


class SyncRun(Base):
    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(12))  # hourly | daily | manual
    mode: Mapped[str] = mapped_column(String(12))  # incremental | full
    status: Mapped[str] = mapped_column(String(12), index=True)
    triggered_by: Mapped[str] = mapped_column(String(320), default="scheduler")
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    new_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, default=0)
    unchanged_count: Mapped[int] = mapped_column(Integer, default=0)
    expired_count: Mapped[int] = mapped_column(Integer, default=0)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, default=0)
    flagged_count: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class SourceCursor(Base):
    __tablename__ = "source_cursors"

    source_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    max_rowid: Mapped[int] = mapped_column(BigInteger, default=0)
    max_last_seen: Mapped[str | None] = mapped_column(String(40))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SourceRowState(Base):
    __tablename__ = "source_row_state"

    source_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    row_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    row_hash: Mapped[str] = mapped_column(String(40))
    ioc_type: Mapped[str | None] = mapped_column(String(16))
    value_norm: Mapped[str | None] = mapped_column(Text)
    seen_run_id: Mapped[int | None] = mapped_column(Integer)


class WorkerState(Base):
    __tablename__ = "worker_state"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

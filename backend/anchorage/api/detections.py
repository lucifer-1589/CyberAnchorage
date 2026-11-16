"""Detections + event ingest (real-time seam)."""

from __future__ import annotations

import hmac
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from anchorage.api.deps import SessionDep, Viewer, _bearer, user_from_token
from anchorage.core.config import get_settings
from anchorage.models import Detection
from anchorage.models.enums import ROLE_RANK, Role
from anchorage.realtime.service import MAX_EVENTS_PER_REQUEST, current_index, detection_to_dict, ingest

router = APIRouter(tags=["detections"])


class IngestIn(BaseModel):
    source: str = Field("api", min_length=1, max_length=80)
    events: list[dict[str, Any]] = Field(min_length=1, max_length=MAX_EVENTS_PER_REQUEST)


async def _ingest_auth(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    x_ingest_token: Annotated[str | None, Header()] = None,
) -> str:
    """Analyst/admin JWT, or the shared INGEST_TOKEN for machine senders."""
    expected = get_settings().ingest_token
    if x_ingest_token and expected and hmac.compare_digest(x_ingest_token, expected):
        return "ingest-token"
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    user = await user_from_token(session, creds.credentials)
    if ROLE_RANK[Role(user.role)] < ROLE_RANK[Role.analyst]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires analyst role")
    return user.email


@router.post("/events/ingest")
async def ingest_events(body: IngestIn, who: Annotated[str, Depends(_ingest_auth)]) -> dict[str, Any]:
    rows = await ingest(body.events, body.source)
    return {"processed": len(body.events), "detections": [detection_to_dict(d) for d in rows]}


@router.get("/detections")
async def list_detections(
    _: Viewer, session: SessionDep,
    verdict: list[str] = Query(default=[]), severity: list[str] = Query(default=[]),
    simulated: bool | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    q = select(Detection)
    if verdict:
        q = q.where(Detection.verdict.in_(verdict))
    if severity:
        q = q.where(Detection.severity.in_(severity))
    if simulated is not None:
        q = q.where(Detection.is_simulated.is_(simulated))
    total = await session.scalar(select(func.count()).select_from(q.subquery()))
    rows = (await session.execute(q.order_by(Detection.id.desc()).limit(limit).offset(offset))).scalars()
    return {"items": [detection_to_dict(d) for d in rows], "total": int(total or 0), "limit": limit, "offset": offset}


@router.get("/realtime/status")
async def realtime_status(_: Viewer) -> dict[str, Any]:
    s = get_settings()
    return {"event_source": "simulator" if s.enable_simulator else "none", "simulator": s.enable_simulator,
            "ingest_token_configured": bool(s.ingest_token), "index": current_index().stats()}

"""IOC explorer: list/filter/facets/detail, raw reveal (audited), saved views, palette search."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import Select, String, cast, func, literal_column, or_, select

from anchorage.api.deps import Analyst, SessionDep, Viewer, client_ip
from anchorage.api.schemas import IocOut, Page, RuleOut
from anchorage.core.audit import audit
from anchorage.ioc.normalize import defang, guess, refang
from anchorage.models import Detection, Ioc, IocFlag, Rule, SavedView

router = APIRouter(tags=["iocs"])

COUNT_CAP = 100_000
SortKey = Literal["last_seen", "first_seen", "score", "severity", "value", "source_count"]


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class IocFilters(BaseModel):
    q: str | None = Field(None, max_length=300)
    type: list[str] = []
    verdict: list[str] = []  # "none" = unflagged
    severity: list[str] = []
    source: list[str] = []
    tag: list[str] = []
    malware: str | None = Field(None, max_length=80)
    actor: str | None = Field(None, max_length=80)
    tlp: list[str] = []
    status: list[str] = ["active"]
    min_score: float | None = Field(None, ge=0, le=1)
    seen_within_days: int | None = Field(None, ge=1, le=3650)
    new_within_hours: int | None = Field(None, ge=1, le=8760)
    demo: bool | None = None
    allowlisted: bool | None = None


def apply_filters(stmt: Select[Any], f: IocFilters) -> Select[Any]:
    if f.q:
        q = refang(f.q.strip()).lower()
        g = guess(q)
        conds: list[Any] = [Ioc.value_norm.ilike(f"%{_esc(q)}%", escape="\\")]
        if g is not None:
            conds.append(Ioc.value_norm == g.value)
        stmt = stmt.where(or_(*conds))
    if f.type:
        stmt = stmt.where(Ioc.type.in_(f.type))
    if f.verdict:
        named = [v for v in f.verdict if v != "none"]
        parts = [Ioc.verdict.in_(named)] if named else []
        if "none" in f.verdict:
            parts.append(Ioc.verdict.is_(None))
        stmt = stmt.where(or_(*parts))
    if f.severity:
        stmt = stmt.where(Ioc.severity.in_(f.severity))
    if f.source:
        stmt = stmt.where(Ioc.sources.overlap(cast(f.source, Ioc.sources.type)))
    if f.tag:
        stmt = stmt.where(Ioc.tags.contains(cast([t.lower() for t in f.tag], Ioc.tags.type)))
    if f.malware:
        stmt = stmt.where(func.array_to_string(Ioc.malware_families, "|").ilike(f"%{_esc(f.malware)}%", escape="\\"))
    if f.actor:
        stmt = stmt.where(func.array_to_string(Ioc.actors, "|").ilike(f"%{_esc(f.actor)}%", escape="\\"))
    if f.tlp:
        stmt = stmt.where(Ioc.tlp.in_([t.upper() for t in f.tlp]))
    if f.status:
        stmt = stmt.where(Ioc.status.in_(f.status))
    if f.min_score is not None:
        stmt = stmt.where(Ioc.score >= f.min_score)
    now = datetime.now(UTC)
    if f.seen_within_days:
        stmt = stmt.where(Ioc.last_seen >= now - timedelta(days=f.seen_within_days))
    if f.new_within_hours:
        stmt = stmt.where(Ioc.created_at >= now - timedelta(hours=f.new_within_hours))
    if f.demo is not None:
        stmt = stmt.where(Ioc.is_demo.is_(f.demo))
    if f.allowlisted is not None:
        stmt = stmt.where(Ioc.allowlisted.is_(f.allowlisted))
    return stmt


_SORTS = {
    "last_seen": Ioc.last_seen, "first_seen": Ioc.first_seen, "score": Ioc.score,
    "severity": Ioc.severity_rank, "value": Ioc.value_norm, "source_count": Ioc.source_count,
}


@router.get("/iocs", response_model=Page)
async def list_iocs(
    _: Viewer,
    session: SessionDep,
    request: Request,
    sort: SortKey = "last_seen",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
) -> Page:
    f = parse_filters(request)
    base = apply_filters(select(Ioc), f)
    total = await session.scalar(select(func.count()).select_from(
        base.with_only_columns(Ioc.id).limit(COUNT_CAP + 1).subquery()))
    col = _SORTS[sort]
    ordering = col.desc().nulls_last() if order == "desc" else col.asc().nulls_last()
    rows = (await session.execute(base.order_by(ordering, Ioc.id.desc()).limit(limit).offset(offset))).scalars()
    total_i = int(total or 0)
    return Page(items=[IocOut.model_validate(r) for r in rows], total=min(total_i, COUNT_CAP), limit=limit,
                offset=offset, total_is_estimate=total_i > COUNT_CAP)


def parse_filters(request: Request) -> IocFilters:
    """Build filters from repeated query params (?type=ipv4&type=domain&status=all ...)."""
    qp = request.query_params
    args: dict[str, Any] = {k: qp.getlist(k) for k in ("type", "verdict", "severity", "source", "tag", "tlp")
                            if k in qp}
    if "status" in qp:
        args["status"] = [v for v in qp.getlist("status") if v != "all"]
    for k in ("q", "malware", "actor", "min_score", "seen_within_days", "new_within_hours"):
        if qp.get(k):
            args[k] = qp[k]
    for k in ("demo", "allowlisted"):
        if k in qp:
            args[k] = qp[k].lower() in ("1", "true", "yes")
    try:
        return IocFilters.model_validate(args)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@router.get("/iocs/facets")
async def facets(_: Viewer, session: SessionDep, request: Request) -> dict[str, Any]:
    f = parse_filters(request)
    sub = apply_filters(select(Ioc), f).subquery()

    async def group(col: Any) -> list[dict[str, Any]]:
        rows = (await session.execute(select(col.label("k"), func.count().label("n")).select_from(sub)
                                      .group_by(literal_column("k")).order_by(func.count().desc()).limit(25))).all()
        return [{"key": k, "count": n} for k, n in rows if k is not None]

    src = func.unnest(sub.c.sources)
    tag = func.unnest(sub.c.tags)
    return {"type": await group(sub.c.type), "verdict": await group(func.coalesce(sub.c.verdict, "none")),
            "severity": await group(sub.c.severity), "tlp": await group(sub.c.tlp),
            "source": await group(src), "tag": await group(tag), "status": await group(sub.c.status)}


class SourceRefOut(BaseModel):
    k: str
    source: str
    title: str | None = None
    url: str | None = None
    first_seen: str | None = None
    last_seen: str | None = None
    channels: list[str] = []
    sightings: int | None = None
    severity: str | None = None
    messages: list[dict[str, Any]] = []


class FlagBrief(BaseModel):
    rule_id: int
    rule_name: str
    rule_version: int
    current_rule_version: int
    verdict: str
    severity: str
    ts: datetime


class IocDetail(BaseModel):
    ioc: IocOut
    source_refs: list[SourceRefOut]
    flags: list[FlagBrief]
    detections: int
    raw_available: bool


@router.get("/iocs/{ioc_id}", response_model=IocDetail)
async def ioc_detail(ioc_id: int, _: Viewer, session: SessionDep) -> IocDetail:
    ioc = await session.get(Ioc, ioc_id)
    if ioc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "IOC not found")
    flags = (await session.execute(select(IocFlag, Rule).join(Rule, Rule.id == IocFlag.rule_id)
                                   .where(IocFlag.ioc_id == ioc_id)
                                   .order_by(IocFlag.severity_rank.desc()))).all()
    det = await session.scalar(select(func.count()).select_from(Detection).where(Detection.ioc_id == ioc_id))
    refs = []
    for r in ioc.source_refs or []:
        d = dict(r)
        if d.get("url"):
            d["url"] = defang(str(d["url"]), "url")  # source URLs are dark-web links: never clickable
        refs.append(SourceRefOut.model_validate({k: v for k, v in d.items() if k in SourceRefOut.model_fields}))
    return IocDetail(
        ioc=IocOut.model_validate(ioc), source_refs=refs,
        flags=[FlagBrief(rule_id=r.id, rule_name=r.name, rule_version=f.rule_version, current_rule_version=r.version,
                         verdict=f.verdict, severity=f.severity, ts=f.ts) for f, r in flags],
        detections=int(det or 0), raw_available=True)


class RevealOut(BaseModel):
    value: str
    value_raw: str | None


@router.post("/iocs/{ioc_id}/reveal", response_model=RevealOut)
async def reveal(ioc_id: int, user: Analyst, session: SessionDep, request: Request) -> RevealOut:
    """Deliberate, audited action: returns the live (fanged) value for copy/pivot."""
    ioc = await session.get(Ioc, ioc_id)
    if ioc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "IOC not found")
    await audit(session, user, "ioc.reveal", "ioc", ioc.id, after={"type": ioc.type}, ip=client_ip(request))
    await session.commit()
    return RevealOut(value=ioc.value_norm, value_raw=ioc.value_raw)


# ------------------------------------------------------------ saved views ---

class ViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    page: str = Field("iocs", max_length=40)
    filters: dict[str, Any]
    shared: bool = False


class ViewOut(ViewIn):
    id: int
    user_id: int
    created_at: datetime
    model_config = {"from_attributes": True}


@router.get("/views", response_model=list[ViewOut])
async def list_views(user: Viewer, session: SessionDep, page: str = "iocs") -> list[SavedView]:
    q = select(SavedView).where(SavedView.page == page,
                                or_(SavedView.user_id == user.id, SavedView.shared.is_(True))).order_by(SavedView.name)
    return list((await session.execute(q)).scalars())


@router.post("/views", response_model=ViewOut, status_code=201)
async def create_view(body: ViewIn, user: Viewer, session: SessionDep) -> SavedView:
    if len(str(body.filters)) > 8000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "filters too large")
    v = SavedView(user_id=user.id, **body.model_dump())
    session.add(v)
    await session.commit()
    return v


@router.delete("/views/{view_id}", status_code=204, response_model=None)
async def delete_view(view_id: int, user: Viewer, session: SessionDep) -> None:
    v = await session.get(SavedView, view_id)
    if v is None or v.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "View not found")
    await session.delete(v)
    await session.commit()


# ----------------------------------------------------------------- search ---

@router.get("/search")
async def search(_: Viewer, session: SessionDep, q: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    term = refang(q.strip()).lower()
    g = guess(term)
    conds: list[Any] = [Ioc.value_norm.ilike(f"%{_esc(term)}%", escape="\\")]
    if g:
        conds.append(Ioc.value_norm == g.value)
    exact_first = (Ioc.value_norm == (g.value if g else term)).desc()
    iocs = (await session.execute(select(Ioc).where(or_(*conds)).order_by(exact_first, Ioc.severity_rank.desc(),
                                                                          Ioc.last_seen.desc().nulls_last())
                                  .limit(8))).scalars()
    rules = (await session.execute(select(Rule).where(Rule.deleted_at.is_(None),
                                                      or_(Rule.name.ilike(f"%{_esc(q)}%", escape="\\"),
                                                          cast(Rule.id, String) == q.strip()))
                                   .order_by(Rule.priority).limit(6))).scalars()
    return {"iocs": [IocOut.model_validate(i) for i in iocs], "rules": [RuleOut.model_validate(r) for r in rules]}

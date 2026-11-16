"""Rule engine: retro pass (SQL push-down), dry-run, verdict precedence."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, delete, exists, func, literal, literal_column, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from anchorage.core.runtime_settings import load_runtime_settings
from anchorage.models import Ioc, IocFlag, Rule
from anchorage.models.enums import SEVERITY_RANK, Severity
from anchorage.rules.allowlist import refresh_allowlisted
from anchorage.rules.compile import EvalContext, compile_sql
from anchorage.rules.schema import parse_condition

SAMPLE_SIZE = 20

# Highest severity wins, then verdict rank, then the rule's priority (lower number first).
_RECOMPUTE_VERDICTS = text("""
UPDATE iocs i SET verdict = t.verdict, severity = t.severity, severity_rank = t.severity_rank
FROM (
  SELECT DISTINCT ON (f.ioc_id) f.ioc_id, f.verdict, f.severity, f.severity_rank
  FROM ioc_flags f JOIN rules r ON r.id = f.rule_id
  ORDER BY f.ioc_id, f.severity_rank DESC,
           CASE f.verdict WHEN 'malicious' THEN 3 WHEN 'suspicious' THEN 2 ELSE 1 END DESC,
           r.priority ASC, r.id ASC
) t
WHERE i.id = t.ioc_id
  AND (i.verdict IS DISTINCT FROM t.verdict OR i.severity IS DISTINCT FROM t.severity)
""")
_CLEAR_VERDICTS = text("""
UPDATE iocs SET verdict = NULL, severity = NULL, severity_rank = 0
WHERE verdict IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ioc_flags f WHERE f.ioc_id = iocs.id)
""")


def eligible() -> Any:
    """IOCs that may carry flags: active and not allowlisted."""
    return and_(Ioc.status == "active", Ioc.allowlisted.is_(False))


def rule_is_live(rule: Rule, now: datetime) -> bool:
    return rule.enabled and rule.deleted_at is None and (rule.expires_at is None or rule.expires_at > now)


class RuleEngine:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _timeouts(self) -> None:
        rt = await load_runtime_settings(self.session)
        await self.session.execute(select(func.set_config("statement_timeout",
                                                          str(rt.retro_statement_timeout_ms), True)))

    async def evaluate_rule(self, rule: Rule, now: datetime | None = None) -> dict[str, int]:
        """Upsert flags for current matches; delete flags that no longer match. Caller recomputes verdicts."""
        now = now or datetime.now(UTC)
        if not rule_is_live(rule, now):
            removed = await self.session.execute(delete(IocFlag).where(IocFlag.rule_id == rule.id))
            rule.match_count = 0
            rule.last_evaluated_at = now
            return {"new": 0, "removed": int(removed.rowcount or 0), "total": 0}

        cond = compile_sql(parse_condition(rule.condition), EvalContext(now=now))
        rank = SEVERITY_RANK[Severity(rule.severity)]
        src = select(Ioc.id, literal(rule.id), literal(rule.version), literal(rule.verdict), literal(rule.severity),
                     literal(rank), literal(now), literal(now)).where(cond, eligible())
        base = pg_insert(IocFlag).from_select(
            ["ioc_id", "rule_id", "rule_version", "verdict", "severity", "severity_rank", "ts", "updated_at"], src)
        ins: Any = base.on_conflict_do_update(
            constraint="uq_flags_ioc_rule",
            set_={"rule_version": base.excluded.rule_version, "verdict": base.excluded.verdict,
                  "severity": base.excluded.severity, "severity_rank": base.excluded.severity_rank,
                  "updated_at": base.excluded.updated_at},
        ).returning(literal_column("(xmax = 0)").label("inserted"))
        rows = (await self.session.execute(ins)).all()
        new = sum(1 for r in rows if r.inserted)

        still = exists(select(Ioc.id).where(Ioc.id == IocFlag.ioc_id, cond, eligible()))
        removed = await self.session.execute(
            delete(IocFlag).where(IocFlag.rule_id == rule.id, ~still).execution_options(synchronize_session=False))
        rule.match_count = len(rows)
        rule.last_evaluated_at = now
        return {"new": new, "removed": int(removed.rowcount or 0), "total": len(rows)}

    async def recompute_verdicts(self) -> None:
        await self.session.execute(_RECOMPUTE_VERDICTS)
        await self.session.execute(_CLEAR_VERDICTS)

    async def purge_ineligible(self) -> int:
        """Allowlisted or non-active IOCs never keep flags."""
        res = await self.session.execute(delete(IocFlag).where(
            exists(select(Ioc.id).where(Ioc.id == IocFlag.ioc_id,
                                        or_(Ioc.allowlisted.is_(True), Ioc.status != "active"))))
            .execution_options(synchronize_session=False))
        return int(res.rowcount or 0)

    async def evaluate_all(self) -> dict[str, Any]:
        now = datetime.now(UTC)
        await self._timeouts()
        await refresh_allowlisted(self.session, now)
        purged = await self.purge_ineligible()
        rules = list((await self.session.execute(select(Rule).where(Rule.deleted_at.is_(None))
                                                 .order_by(Rule.priority, Rule.id))).scalars())
        totals = {"new_flags": 0, "removed_flags": purged, "rules": 0}
        for rule in rules:
            r = await self.evaluate_rule(rule, now)
            totals["new_flags"] += r["new"]
            totals["removed_flags"] += r["removed"]
            totals["rules"] += 1 if rule_is_live(rule, now) else 0
        # flags of soft-deleted rules
        await self.session.execute(delete(IocFlag).where(IocFlag.rule_id.in_(
            select(Rule.id).where(Rule.deleted_at.is_not(None)))))
        await self.recompute_verdicts()
        await self.session.flush()
        await _publish_flags(totals)
        return totals

    async def evaluate_one(self, rule: Rule) -> dict[str, Any]:
        await self._timeouts()
        await refresh_allowlisted(self.session)
        res = await self.evaluate_rule(rule)
        await self.recompute_verdicts()
        await self.session.flush()
        await _publish_flags({"new_flags": res["new"], "removed_flags": res["removed"], "rule_id": rule.id})
        return res

    async def dry_run(self, condition: dict[str, Any], limit: int = SAMPLE_SIZE) -> dict[str, Any]:
        """Matched count + sample IOCs, no writes. Allowlisted/non-active IOCs are reported separately."""
        await self._timeouts()
        now = datetime.now(UTC)
        cond = compile_sql(parse_condition(condition), EvalContext(now=now))
        total = await self.session.scalar(select(func.count()).select_from(Ioc).where(cond, eligible()))
        suppressed = await self.session.scalar(select(func.count()).select_from(Ioc).where(
            cond, Ioc.allowlisted.is_(True)))
        rows = (await self.session.execute(select(Ioc).where(cond, eligible())
                                           .order_by(Ioc.score.desc(), Ioc.last_seen.desc().nulls_last())
                                           .limit(limit))).scalars().all()
        return {"count": int(total or 0), "allowlisted": int(suppressed or 0), "samples": rows}


async def _publish_flags(data: dict[str, Any]) -> None:
    from anchorage.core.bus import CONTROL, EVENTS, get_bus

    bus = get_bus()
    await bus.publish(EVENTS, "flags.updated", data)
    await bus.publish(CONTROL, "index.rebuild", {"reason": "flags"})

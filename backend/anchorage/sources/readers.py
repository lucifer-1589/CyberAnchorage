"""Per-store table readers. Column names match the real CTI schemas (PLAN.md §1).

Readers select only metadata columns. `context`, `analyst_note`, Telegram message text and sighting
context are never selected.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from anchorage.ioc.normalize import PII_TYPES, SOURCE_TYPE_ALIASES
from anchorage.ioc.records import RawIoc
from anchorage.sources.base import (
    SEVERITY_SCORE,
    Cursor,
    SourceRow,
    conf_to_float,
    parse_dt,
    split_csv,
    structured_from_json,
)
from anchorage.sources.snapshot import has_table, table_columns

# Only rows whose type could be in scope are fetched; PII types are never read at all.
IN_SCOPE_SOURCE_TYPES = tuple(sorted(SOURCE_TYPE_ALIASES))
_TYPE_PLACEHOLDERS = ",".join("?" * len(IN_SCOPE_SOURCE_TYPES))
assert not set(IN_SCOPE_SOURCE_TYPES) & PII_TYPES


@dataclass(slots=True)
class ReaderSpec:
    store: str
    table: str
    type_col: str
    last_seen_col: str | None


def _where(spec: ReaderSpec, cursor: Cursor | None, alias: str = "") -> tuple[str, list[Any]]:
    a = f"{alias}." if alias else ""
    clauses = [f"{a}rowid > ?", f"lower({a}{spec.type_col}) IN ({_TYPE_PLACEHOLDERS})"]
    params: list[Any] = [None, *IN_SCOPE_SOURCE_TYPES]
    if cursor is not None:
        if spec.last_seen_col and cursor.max_last_seen:
            clauses.append(f"({a}rowid > ? OR {a}{spec.last_seen_col} >= ?)")
            params += [cursor.max_rowid, cursor.max_last_seen]
        else:
            clauses.append(f"{a}rowid > ?")
            params.append(cursor.max_rowid)
    return " AND ".join(clauses), params


def count_out_of_scope(con: sqlite3.Connection, spec: ReaderSpec) -> int:
    sql = f'SELECT count(*) FROM "{spec.table}" WHERE lower({spec.type_col}) NOT IN ({_TYPE_PLACEHOLDERS})'
    return int(con.execute(sql, IN_SCOPE_SOURCE_TYPES).fetchone()[0])


# ---------------------------------------------------------- crawler/connector ---

CRAWLER_SPEC = {s: ReaderSpec(s, "iocs", "ioc_type", "last_seen") for s in ("crawler", "connector")}


def read_crawler_like(con: sqlite3.Connection, spec: ReaderSpec, source: str, is_demo: bool,
                      after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
    cols = table_columns(con, "iocs")
    opt = [c for c in ("tags", "origin", "raw_json", "score", "severity", "subtype", "sightings") if c in cols]
    select = ["rowid AS _rowid", "id", "ioc_type", "value", "source_url", "source_title", "confidence", "tlp",
              "first_seen", "last_seen", *opt]
    where, params = _where(spec, cursor)
    params[0] = after_rowid
    sql = f"SELECT {', '.join(select)} FROM iocs WHERE {where} ORDER BY rowid LIMIT ?"
    out: list[SourceRow] = []
    for r in con.execute(sql, [*params, limit]):
        row = dict(r)
        extra = structured_from_json(row.get("raw_json"))
        score = row.get("score")
        tags = split_csv(row.get("tags")) + extra["tags"]
        if row.get("subtype") and row["subtype"] != "GENERAL":
            tags.append(str(row["subtype"]))
        if row.get("origin"):
            tags.append(f"origin:{row['origin']}")
        raw = RawIoc(
            source=source, store=spec.store, table="iocs", row_key=str(row["id"]),
            ioc_type=row["ioc_type"] or "", value=row["value"] or "",
            first_seen=parse_dt(row.get("first_seen")), last_seen=parse_dt(row.get("last_seen")),
            tlp=row.get("tlp"),
            score=(float(score) / 100 if score is not None else SEVERITY_SCORE.get(str(row.get("severity")).lower())),
            confidence=conf_to_float(row.get("confidence")),
            tags=tags, malware_families=extra["malware"], actors=extra["actors"], mitre_ids=extra["mitre"],
            ref={"title": row.get("source_title"), "url": row.get("source_url"),
                 "sightings": row.get("sightings"), "severity": row.get("severity")},
            is_demo=is_demo, cursor_last_seen=row.get("last_seen"),
        )
        out.append(SourceRow(int(row["_rowid"]), row.get("last_seen"), raw))
    return out


# ------------------------------------------------------------------ ioc_hunter ---

HUNTER_SPEC = ReaderSpec("ioc_hunter", "iocs", "ioc_type", "extracted_at")


Enrich = dict[tuple[str, str], dict[str, set[str]]]


def _hunter_enrichment(con: sqlite3.Connection, keys_in: Iterable[tuple[str, str]]) -> Enrich:
    keys = list({k for k in keys_in if k[0]})
    out: Enrich = defaultdict(lambda: {"actors": set(), "mitre": set(), "malware": set()})
    if not keys:
        return out
    run_ids = sorted({k[0] for k in keys})
    ph = ",".join("?" * len(run_ids))
    if has_table(con, "ttp_relations"):
        for r in con.execute(f"SELECT run_id, source_url, group_name, ttp, ransomware_family FROM ttp_relations "
                             f"WHERE run_id IN ({ph})", run_ids):
            e = out[(r["run_id"], r["source_url"] or "")]
            if r["group_name"]:
                e["actors"].add(r["group_name"])
            if r["ttp"]:
                e["mitre"].add(r["ttp"])
            if r["ransomware_family"]:
                e["malware"].add(r["ransomware_family"])
    if has_table(con, "malware_mentions"):
        for r in con.execute(f"SELECT run_id, source_url, malware_name, apt_group FROM malware_mentions "
                             f"WHERE run_id IN ({ph})", run_ids):
            e = out[(r["run_id"], r["source_url"] or "")]
            if r["malware_name"]:
                e["malware"].add(r["malware_name"])
            if r["apt_group"]:
                e["actors"].add(r["apt_group"])
    return out


def read_ioc_hunter(con: sqlite3.Connection, source: str, is_demo: bool,
                    after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
    spec = HUNTER_SPEC
    where, params = _where(spec, cursor)
    params[0] = after_rowid
    sql = (f"SELECT rowid AS _rowid, id, run_id, ioc_type, value, normalized, confidence, category, tags, "
           f"source_url, source_title, source_domain, extracted_at FROM iocs WHERE {where} ORDER BY rowid LIMIT ?")
    rows = [dict(r) for r in con.execute(sql, [*params, limit])]
    enrich = _hunter_enrichment(con, ((r["run_id"], r["source_url"] or "") for r in rows))
    out: list[SourceRow] = []
    for row in rows:
        e = enrich.get((row["run_id"], row["source_url"] or ""), {"actors": set(), "mitre": set(), "malware": set()})
        tags = split_csv(row.get("tags"))
        if row.get("category"):
            tags.append(str(row["category"]))
        seen = parse_dt(row.get("extracted_at"))
        raw = RawIoc(
            source=source, store="ioc_hunter", table="iocs", row_key=str(row["id"]),
            ioc_type=row["ioc_type"] or "", value=row.get("normalized") or row["value"] or "",
            first_seen=seen, last_seen=seen, tlp=None, score=None,
            confidence=conf_to_float(row.get("confidence")),
            tags=tags, malware_families=sorted(e["malware"]), actors=sorted(e["actors"]), mitre_ids=sorted(e["mitre"]),
            ref={"title": row.get("source_title"), "url": row.get("source_url"), "domain": row.get("source_domain"),
                 "run_id": row.get("run_id")},
            is_demo=is_demo, cursor_last_seen=row.get("extracted_at"),
        )
        out.append(SourceRow(int(row["_rowid"]), row.get("extracted_at"), raw))
    return out


# -------------------------------------------------------------------- telegram ---

TELEGRAM_SPEC = ReaderSpec("telegram", "iocs", "ioc_type", "last_seen")
MAX_SIGHTING_REFS = 20


def read_telegram(con: sqlite3.Connection, source: str, is_demo: bool,
                  after_rowid: int, limit: int, cursor: Cursor | None) -> list[SourceRow]:
    spec = TELEGRAM_SPEC
    where, params = _where(spec, cursor)
    params[0] = after_rowid
    sql = (f"SELECT rowid AS _rowid, id, ioc_type, ioc_value, confidence, first_seen, last_seen, sightings, "
           f"channel_count, severity, categories, malware_fams FROM iocs WHERE {where} ORDER BY rowid LIMIT ?")
    rows = [dict(r) for r in con.execute(sql, [*params, limit])]
    sightings: dict[int, list[dict[str, Any]]] = defaultdict(list)
    if rows and has_table(con, "ioc_sightings"):
        ids = [r["id"] for r in rows]
        ph = ",".join("?" * len(ids))
        # context column deliberately NOT selected (raw message text)
        for s in con.execute(f"SELECT ioc_id, channel_name, message_id, date FROM ioc_sightings "
                             f"WHERE ioc_id IN ({ph}) ORDER BY date DESC", ids):
            if len(sightings[s["ioc_id"]]) < MAX_SIGHTING_REFS:
                sightings[s["ioc_id"]].append({"channel": s["channel_name"], "message_id": s["message_id"],
                                               "date": s["date"]})
    out: list[SourceRow] = []
    for row in rows:
        sev = str(row.get("severity") or "").lower()
        sg = sightings.get(row["id"], [])
        channels = sorted({s["channel"] for s in sg if s.get("channel")})
        raw = RawIoc(
            source=source, store="telegram", table="iocs", row_key=str(row["id"]),
            ioc_type=row["ioc_type"] or "", value=row["ioc_value"] or "",
            first_seen=parse_dt(row.get("first_seen")), last_seen=parse_dt(row.get("last_seen")),
            tlp=None, score=SEVERITY_SCORE.get(sev), confidence=conf_to_float(row.get("confidence")),
            tags=[c.lower() for c in split_csv(row.get("categories"))],
            malware_families=split_csv(row.get("malware_fams")),
            ref={"title": "Telegram: " + ", ".join(channels) if channels else "Telegram",
                 "channels": channels, "sightings": row.get("sightings"), "severity": row.get("severity"),
                 "messages": sg},
            is_demo=is_demo, cursor_last_seen=row.get("last_seen"),
        )
        out.append(SourceRow(int(row["_rowid"]), row.get("last_seen"), raw))
    return out


READERS: dict[str, tuple[ReaderSpec, Any]] = {
    "crawler": (CRAWLER_SPEC["crawler"], lambda con, *a: read_crawler_like(con, CRAWLER_SPEC["crawler"], *a)),
    "connector": (CRAWLER_SPEC["connector"], lambda con, *a: read_crawler_like(con, CRAWLER_SPEC["connector"], *a)),
    "ioc_hunter": (HUNTER_SPEC, read_ioc_hunter),
    "telegram": (TELEGRAM_SPEC, read_telegram),
}


# ----------------------------------------------------------- core.db enrichment ---

def load_apt_dictionary(con: sqlite3.Connection) -> dict[str, dict[str, list[str]]]:
    """malware family (lowercase) → {"actors": [...], "mitre": [...]} from core.db `apts`."""
    out: dict[str, dict[str, list[str]]] = {}
    if not has_table(con, "apts"):
        return out
    for r in con.execute("SELECT group_name, aliases, malware_families, ttps FROM apts"):
        group = (r["group_name"] or "").strip()
        if not group:
            continue
        ttps = [t for t in split_csv(r["ttps"]) if t.upper().startswith("T")]
        for fam in split_csv(r["malware_families"]):
            e = out.setdefault(fam.lower(), {"actors": [], "mitre": []})
            if group not in e["actors"]:
                e["actors"].append(group)
            e["mitre"] = sorted(set(e["mitre"]) | set(ttps))
    return out

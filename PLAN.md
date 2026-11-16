# CyberAnchorage — Level 1 Plan

Network-IOC intake from the Dark Web CTI stores + rule-based flagging, with a real-time seam
for the later event stream. Companion docs: `DECISIONS.md` (why), `CLAUDE.md` (how to work here).

## 1. What the CTI stores actually contain (inspected read-only, 2026-11-16)

Located at `../Darkweb_CTI/Darkweb_CTI/` (`CTI_DATA_DIR` was unset):

| Store | Table(s) used | Rows today | Columns we read |
|---|---|---|---|
| `darkweb_intel/crawler.db` | `iocs` | 0 | id, ioc_type, value, source_url, source_title, confidence (LOW/MEDIUM/HIGH), tlp (WHITE…), first_seen, last_seen, tags (csv), origin, raw_json, score (0-100), severity, subtype, sightings |
| `darkweb_intel/connector.db` | `iocs` | 0 | same as crawler |
| `darkweb_intel/ioc_hunter.db` | `iocs` + `ttp_relations` + `malware_mentions` | 0 | iocs: id, run_id, ioc_type, value, normalized, confidence, category, tags, source_url, source_title, source_domain, extracted_at; enrichment joined on (run_id, source_url) → actor (group_name), MITRE (ttp), malware_name |
| `telegram-scraper/database/intel_iocs.db` | `iocs` + `ioc_sightings` | 257 / 270 | iocs: id, ioc_type, ioc_value, confidence, first_seen, last_seen, sightings, channels, channel_count, severity, categories, malware_fams; sightings: ioc_id, channel_name, message_id, date, confidence |
| `darkweb_intel/core.db` | `apts` (enrichment only) | 44 | group_name, aliases, malware_families, ttps — used as a malware-family → actor/MITRE dictionary |

Columns we deliberately **never** copy: `context`, `raw_json` free text, `analyst_note`,
`ioc_sightings.context`, `messages.*`, `crawl_log.text_snippet` (raw dark-web / Telegram content).
`raw_json` is parsed only for structured keys (`malware_family`, `actor`, `mitre`) and then discarded.

Source type vocabulary observed → canonical type:

| Source `ioc_type` | Canonical |
|---|---|
| ipv4, ip_v4, ip_address (v4) | `ipv4` |
| ipv6, ip_v6, ip_address (v6) | `ipv6` |
| cidr | `cidr` |
| domain (if `.onion` → onion) | `domain` |
| url, url_pattern | `url` |
| dark_url, onion, onion_v2, onion_v3 | `onion` (host only) or `url` (when it has a path) |
| ipv4_port, ip_port, ip:port | `ip:port` |
| asn | `asn` |
| ja3, ja3s | `ja3` / `ja3s` |
| ssn_like, card_like, iban_like, credential, ssn_pattern, cc_pattern, iban_pattern | **dropped always** (PII) |
| everything else (md5, sha*, email, cve, wallets, telegram, jabber, i2p…) | ignored in Level 1 |

## 2. Architecture

```
 CTI SQLite files (read-only)                       ┌────────── web (nginx + React SPA) ──────────┐
   │  sqlite backup API → private snapshot           │  /api/* and /api/ws proxied to api           │
   ▼                                                 └──────────────────┬───────────────────────────┘
 worker (APScheduler)                                                   │
   hourly incremental / daily 07:00 UTC reconcile    api (FastAPI, uvicorn)
   IocSource adapters → Normalizer → Merger(upsert)   auth/RBAC, IOC/rules/flags/allowlist/sync/audit
   → RuleEngine retro pass (SQL push-down)            RuleEngine dry-run + retro pass on save
   writes sync_runs, publishes events ───► Redis ◄─── MatcherIndex (in-memory, rebuilt on pub/sub)
                                           pub/sub    POST /api/events/ingest → detections
                           PostgreSQL 16 ◄────────────┘ WebSocket fan-out of bus events
```

Backend package layout (`backend/anchorage/`):

```
core/      config, db session, security (jwt/argon2), bus (redis|memory), rate limit, logging
models/    SQLAlchemy models (one module per aggregate)
ioc/       types registry, normalizer, defang, merge (upsert SQL)
sources/   IocSource protocol, SqliteSnapshotSource, HttpSource, readers per CTI store, enrichment
sync/      SyncService (incremental/full, cursors, aging, advisory lock), scheduler/worker
rules/     schema (pydantic AST), validator, python compiler, SQL compiler, engine (retro/dry-run)
realtime/  EventSource protocol, MatcherIndex (hash sets, radix trie, label trie), detector, simulator
api/       routers + deps (auth, rbac), websocket
demo/      fixture CTI generator (seed-demo)
cli.py     create-admin, seed-demo, sync, rebuild-flags
```

## 3. Database schema (PostgreSQL 16, Alembic-managed)

- `users` (id, email uniq, name, password_hash argon2, role admin|analyst|viewer, is_active, timestamps)
- `refresh_tokens` (jti PK, user_id, expires_at, revoked_at, replaced_by) — rotation + reuse detection
- `audit_log` (id, ts, actor_id, actor_email, action, entity_type, entity_id, before JSONB, after JSONB, ip)
- `iocs`
  - identity: id, `type`, `value_norm`, **UNIQUE(type, value_norm)**
  - typed columns for indexing: `ip inet`, `net cidr`, `port int`, `asn bigint`, `host text`, `host_rev text`
  - intel: `sources text[]`, `source_count int`, `source_refs JSONB` (store/table/row/title/url/first/last — no content),
    `first_seen`, `last_seen`, `tlp`, `tlp_rank`, `score real (0-1)`, `confidence real (0-1)`,
    `tags text[]`, `malware_families text[]`, `actors text[]`, `mitre_ids text[]`
  - state: `status active|expired|retired`, `expires_at`, `allowlisted bool`, `verdict`, `severity`, `severity_rank`,
    `is_demo`, `created_at`, `updated_at`, `last_synced_at`
  - indexes: GiST(ip inet_ops), GiST(net inet_ops), btree(host_rev text_pattern_ops), GIN trgm(value_norm),
    GIN(tags), btree(last_seen), btree(verdict, severity_rank)
- `rules` (id, name, description, enabled, priority, verdict, severity, condition JSONB, expires_at, version, created_by, updated_by, timestamps, deleted_at)
- `rule_versions` (rule_id, version, snapshot JSONB, changed_by, changed_at) PK(rule_id, version)
- `ioc_flags` (id, ioc_id, rule_id, rule_version, verdict, severity, ts, updated_at) UNIQUE(ioc_id, rule_id)
- `allowlist` (id, kind value|cidr|domain_suffix, ioc_type null, value, reason, expires_at, created_by, created_at)
- `sync_runs` (id, kind hourly|daily|manual, mode incremental|full, status queued|running|success|partial|failed|skipped,
  started/finished, counts new/updated/unchanged/expired/rejected/skipped/flagged, errors JSONB, stats JSONB, triggered_by, heartbeat_at)
- `source_cursors` (source_key PK, max_rowid, max_last_seen, updated_at)
- `source_row_state` (source_key, row_key) PK, row_hash, ioc_type, value_norm — hash-diff + "gone from source" detection
- `worker_state` (key PK, value JSONB, updated_at) — scheduler heartbeat + next run times
- `saved_views` (id, user_id, name, filters JSONB, shared)
- `detections` (id, ts, event JSONB (observables only), observable, observable_type, ioc_id, rule_ids, verdict, severity, source, is_simulated)
- `app_settings` (key PK, value JSONB) — admin-editable runtime settings (expiry days, allow_private, default TLP)

## 4. Data flow details

**Ingestion.** `SqliteSnapshotSource` copies each DB with `sqlite3.Connection.backup` from a `mode=ro` URI
connection into a temp file, then reads the snapshot with `mode=ro`. Readers yield `RawIoc` records
(source_key, row_key, type, value, metadata). Normalizer → `NormalizedIoc` or a rejection reason.
Records are aggregated per (type, value_norm) in memory per batch, then merged with one
`INSERT … ON CONFLICT (type, value_norm) DO UPDATE … WHERE <merged> IS DISTINCT FROM <current>`
statement; `RETURNING (xmax = 0)` separates new from updated, unreturned rows are unchanged.

**Hourly (incremental).** Per source table: rows with `rowid > max_rowid OR last_seen >= max_last_seen`
(tables without those columns fall back to full hash diff). Every candidate row is hashed; unchanged
hashes are skipped. Cursors advance only after a batch commits → resumable.

**Daily 07:00 UTC (full reconcile).** All rows, ignoring cursors/hashes; rows that disappeared from a
source drop that source ref (no refs left → `retired`); aging (`ip` 30 d, `domain`/`url` 90 d, others 90 d,
configurable) → `expired`; re-run all rules.

**Concurrency.** `pg_try_advisory_lock` around every run → one run at a time. Stale `running` rows
(heartbeat > 10 min) are marked failed on worker start. Manual "Sync now" inserts a `queued` run and
publishes a wake-up; the worker also polls queued runs every 5 s.

**Rules.** A rule's condition is a validated JSON AST (pydantic discriminated union). The same AST
compiles to (a) a Python predicate (real-time + unit tests) and (b) a SQLAlchemy boolean expression
(retro pass / dry-run). Retro pass per rule = upsert flags for matches, delete flags for non-matches,
then recompute each affected IOC's denormalized verdict (highest severity, then verdict rank, then priority).
Allowlisted / expired IOCs never get flags.

**Real-time seam.** `EventSource` protocol (`NullEventSource`, `SimulatorEventSource`). `MatcherIndex`
holds flagged IOCs (exact hash sets per type, binary radix trie for CIDR, reversed-label trie for
domain suffix) plus the compiled rule predicates; it is rebuilt when `index.rebuild` is published on
Redis (after sync, rule save, allowlist change). `POST /api/events/ingest` extracts observables, looks
them up, evaluates rules against the observable (enriched with IOC metadata on a hit), and writes
`detections`.

## 5. API surface (all under `/api`)

auth (`login`, `refresh`, `logout`, `me`) · users (admin) · iocs (list/filter/facets/detail/raw) ·
stats/overview · rules (CRUD, toggle, versions, dry-run, fields) · flags · allowlist · sync (status, runs,
run) · detections · events/ingest · audit · views · settings (admin) · search (palette) · `ws`.

RBAC: viewer = read; analyst = + rules, allowlist, sync now, reveal raw, saved views; admin = + users, settings.

## 6. Milestones (one commit each, tests green before moving on)

| # | Scope | Gate |
|---|---|---|
| M1 | repo, docker-compose, Makefile, settings, DB models + Alembic, auth/JWT/RBAC, audit log | auth + RBAC tests |
| M2 | IocSource adapters, normalizer, merge/upsert, sync service, scheduler/worker, seed-demo | normalization, merge, idempotent sync, hourly+daily, changed-row tests |
| M3 | rule AST/validator, python + SQL compilers, engine, rules/flags/allowlist API | evaluator (CIDR, suffix, allowlist override), parity, API tests |
| M4 | UI shell (glass theme, sidebar, palette, auth), Overview, IOC Explorer, Sync page | build + Vitest |
| M5 | Rule builder + preview, Flags, Allowlist, Audit, Detections + realtime seam/simulator | detection test + Vitest |
| M6 | polish, responsive/a11y pass, README | full test run, lint |

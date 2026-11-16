# Decisions

Format: decision — reason. Deviations from the requested stack are marked **DEVIATION**.

## Data & ingestion
1. **CTI location**: `CTI_DATA_DIR` was unset; found the stores under `../Darkweb_CTI/Darkweb_CTI/`
   (`darkweb_intel/*.db`, `telegram-scraper/database/intel_iocs.db`). `.env.example` points there; the
   compose file mounts it read-only at `/cti`.
2. **Store discovery is by relative path inside `CTI_DATA_DIR`** (`darkweb_intel/crawler.db`, …) with each
   path overridable — the CTI keeps them in two different sub-folders.
3. **Snapshot strategy**: SQLite online backup API from a `mode=ro` connection into a private temp file;
   if the source can't be opened read-only (e.g. WAL on a read-only mount with no `-shm`), fall back to a
   plain file copy of `db` + `-wal` into the temp dir, then open the copy. The original files are never
   opened writable and no lock is held beyond the backup step.
4. **No raw content**: `context`, `raw_json`, `analyst_note`, Telegram message text and sighting context are
   never stored. Only IOC value, structured metadata, and a source reference (store, table, row id,
   title/URL/channel+message id).
5. **`core.db` apts** is used as a malware-family → actor/MITRE enrichment dictionary (its `iocs` column is
   empty today).
6. **Scores**: CTI `score` 0-100 → 0-1. Telegram has no score; derived from severity
   (CRITICAL .9, HIGH .75, MEDIUM .5, LOW .25). Confidence text → number (LOW .3, MEDIUM .6, HIGH .85).
7. **TLP**: stored as TLP 2.0 (`WHITE` → `CLEAR`). Sources without TLP (Telegram, ioc_hunter) get the
   configurable default `AMBER` — dark-web derived intel should not be treated as shareable by default.
   Strictest wins: CLEAR < GREEN < AMBER < AMBER+STRICT < RED.
8. **CIDR normalization** uses `strict=False` (Telegram has host-bit CIDRs like `85.236.147.162/29` →
   `85.236.147.160/29`).
9. **Onion**: `.onion` hosts become type `onion` (host only, v2/v3 validated). Onion URLs with a non-root
   path stay type `url` with tag `onion` so the path is not lost.
10. **Private/reserved IPs** are rejected (counted in `rejected`) unless the `allow_private_ips` setting is on.
11. **Merge never forgets**: sources/tags/actors are unioned, min first_seen, max last_seen, max score,
    strictest TLP. Removal only happens in the daily reconcile (source ref dropped when the row is gone;
    no refs → `retired`).
12. **Hourly cursor**: the CTI tables have no `updated_at`; CTI upserts keep the same rowid and bump
    `last_seen`. Cursor = `rowid > max_rowid OR last_seen >= max_last_seen`, then per-row hash diff.
    Changes that don't bump `last_seen` are picked up by the daily full reconcile.
13. **Expiry defaults**: ip/cidr/ip:port 30 d; domain/url/onion 90 d; asn/ja3 180 d. Admin-editable.

## Rules
14. **Single AST, two compilers** (Python predicate + SQLAlchemy expression) with a parity test, rather than
    one generic interpreter — the SQL push-down is required for the retro pass over millions of rows and
    the Python form is required for real-time.
15. **Regex safety**: max 256 chars, rejects nested quantifiers (`(a+)+`-style) at validation; Python side
    uses the `regex` module with a 50 ms timeout; SQL side runs the retro pass with
    `SET LOCAL statement_timeout`.
16. **Verdict precedence on an IOC**: highest severity, then verdict rank (malicious > suspicious > abnormal),
    then lowest priority number. Every matching rule is still recorded in `ioc_flags`.
17. **Flags are current state** (UNIQUE ioc_id, rule_id, first `ts` preserved); history lives in
    `rule_versions` + `audit_log`.
18. **Allowlist kinds**: exact value (optionally per type), CIDR containment, domain suffix. Evaluated into
    `iocs.allowlisted` so SQL push-down can exclude them cheaply.

## Platform
19. **Redis is optional in dev**: `REDIS_URL` empty → in-process memory bus (single process only). Docker
    always runs Redis. Tests use the memory bus.
20. **Auth**: access token (15 min) returned in JSON and kept in memory by the SPA; refresh token (7 d,
    rotating, reuse → family revoked) in an `HttpOnly; SameSite=Strict` cookie scoped to `/api/auth`.
21. **Rate limiting**: in-process sliding window on `/auth/login` and `/auth/refresh` (per IP and per email).
    Good enough for a localhost-bound single API instance; move to Redis when scaled out.
22. **Matcher index holds flagged IOCs only** — bounded memory; unflagged IOCs can't produce a detection
    anyway unless a rule matches the bare observable, which is evaluated separately.
23. **Simulator lives in the API process** (needs the in-memory index); off unless `ENABLE_SIMULATOR=true`;
    detections are `is_simulated=true` and badged in the UI.
24. **UI components**: shadcn/ui is a code generator, so its components are vendored in `web/src/components/ui`
    (Radix primitives + Tailwind), restyled with the glass theme.
25. **Glassmorphism, readability first**: glass surfaces are kept ≥ 55 % opaque with a 16-20 px blur over a
    calm, low-contrast backdrop so text contrast stays ≥ 4.5:1 (body text ≈ 12:1 in dark mode). Primary
    `#34A99D` is used as a fill with dark text; in light mode text-on-white uses a darker teal `#1F7A70`
    (≥ 4.5:1). Severity uses the Okabe-Ito colour-blind-safe set *plus* an icon and label, never colour alone.
26. **Fonts self-hosted** via `@fontsource` (no external CDN from a localhost SOC console).

## Local verification (this machine)
27. **DEVIATION (dev only)**: the build machine has no Docker/Postgres/Node. Backend tests run against an
    embedded PostgreSQL 16 started by the `pgserver` wheel when `TEST_DATABASE_URL` is unset; the frontend
    was built/tested with a portable Node 20. The shipped runtime is unchanged (docker-compose).

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
25. *(Superseded by 34 for values; the readability principle stands.)* **Glassmorphism, readability first**: glass surfaces are kept ≥ 55 % opaque with a 16-20 px blur over a
    calm, low-contrast backdrop so text contrast stays ≥ 4.5:1 (body text ≈ 12:1 in dark mode). Primary
    `#34A99D` is used as a fill with dark text; in light mode text-on-white uses a darker teal `#1F7A70`
    (≥ 4.5:1). Severity uses the Okabe-Ito colour-blind-safe set *plus* an icon and label, never colour alone.
26. **Fonts self-hosted** via `@fontsource` (no external CDN from a localhost SOC console).

## Local verification (this machine)
27. **DEVIATION (dev only)**: the build machine has no Docker/Postgres/Node. Backend tests run against an
    embedded PostgreSQL 16 started by the `pgserver` wheel when `TEST_DATABASE_URL` is unset; the frontend
    was built/tested with a portable Node 20. The shipped runtime is unchanged (docker-compose).
28. **pg_trgm is conditional in migration 0001**: created when the extension is available (always in the
    docker image); the embedded dev build lacks it, so search falls back to an unindexed `ILIKE`.
29. **Detections are de-duplicated per event** (one row per IOC/rule per event): `dst_ip` and the derived
    `dst_ip:port` observable usually hit the same IOC and would otherwise double-count.
30. **Rules also run on bare observables** in real time (not only on known IOCs), so an IOC-free rule like
    "ip:port with port 4444" detects on unseen infrastructure — the "same rules on event data" requirement.
31. **Severity/verdict charts use a single-hue ordinal ramp**, not four status hues: the validator showed
    yellow/orange/red adjacent bars are indistinguishable under deuteranopia. Badges keep distinct hues
    but always add an icon, label and a 4-step bar glyph.
32. **Source URLs in the IOC drawer are defanged** and never rendered as links (they point at dark-web pages).
33. **Milestones M4 and M5 landed in one commit**: the UI shell, router and backend realtime seam were built
    together and are only testable as a unit; M6 (polish/README) is a separate commit.

## Royal Glass UI system (web/UI-SYSTEM.md)
34. **Royal Glass replaces the single glass tier.** Three tiers: G0 solid (no blur) for tables, charts,
    logs and rule trees; G1 panel (14 px blur) for the sidebar, header, KPI band and filter bar; G2
    floating (22 px blur) for the one open drawer, palette or menu. At most 6 blurred surfaces per
    viewport. Tokens keep their old CSS variable names, so pages restyled without churn. Contrast is
    checked on composited glass over the brightest orb (`npm run check:contrast`), not on swatches.
35. **Visual effects Auto/Full/Reduced/Off** (`html[data-effects]`). Auto follows a perf tier: a hardware
    hint refined by 60 measured frames. Off and reduced transparency paint a gradient fallback with the
    same edge and shadow. Switching changes paint only; this is verified to 0 layout diffs by `perf:run`.
36. **Blur never moves, and nothing repaints inside blur.** Glass in motion (drawer, route enter, page
    scroll) paints its fallback until it settles. Charts and hover tints live on G0. Measured on a
    software-rasterised 4× CPU run, these rules took Overview from 22 to 51 fps (Full) and 59 (Off).
37. **Route transitions use CSS; the theme switch uses View Transitions.** Real route View Transitions
    need the data router (`createBrowserRouter` + `viewTransition` links). With `BrowserRouter` and
    `v7_startTransition`, navigation commits as a transition that `flushSync` cannot capture. Migrating
    the router was out of scope for the UI pass.
38. **Session refresh starts in index.html** (the CSP already allows inline scripts) and the current
    route chunk is modulepreloaded from an inline route map. Both remove serial round trips before first
    content. Same request, same cookie; `refreshSession()` consumes the early response once.
39. **`motion` (LazyMotion + domAnimation, `m.*` only) and dnd-kit load only in the rule-editor chunk.**
    Everything else animates with CSS or WAAPI. `layout` animations would need `domMax`, so reflow on
    add/remove is instant; reorder animates through dnd-kit's transforms.
40. **IOC table keeps TanStack Table + Virtual** but renders one virtual-body component, coalesces scroll
    to one update per frame, uses slot keys and keeps Radix tooltips out of rows (native `title`). Compact
    rows are 32 px (not 30) so the 24 × 24 row actions fit.
41. **Mobile LCP in Lighthouse's mobile profile stays above 2.0 s (2.5–3.4 s)** for this auth-gated SPA.
    Applied 4G + 4× CPU measures 1.8–1.9 s. Closing the gap needs SSR, Early Hints or a smaller critical
    bundle, which are architecture work outside the UI pass (UI-SYSTEM.md §7).

## Real data by default
42. **CTI stores are copied, never opened.** A `mode=ro` SQLite connection still creates or updates the
    `-shm` (and an empty `-wal`) next to a WAL-mode database. That is a write into the CTI folder, and it
    happened on the first local runs (the database files themselves were never changed). Snapshots now
    file-copy `db` + `-wal`/`-journal`, retry if the source moved during the copy, replay the WAL in the
    private copy and `quick_check` it. The Sync page's row counts use the same snapshots, cached per file
    fingerprint. Rows still in the CTI's WAL are included (`test_wal_store_with_live_writer_...`).
43. **Local mode shows real data only.** `run-local.ps1` seeds demo data only with `-Demo`; otherwise
    `purge-demo --if-present` runs on start. Demo and real sightings of one value merge into one IOC row,
    so the purge clears all ingested state (IOCs, flags, cursors, row hashes, sync history, simulated
    detections) and re-reads the real CTI with a full reconcile. Rules, allowlist, users, settings and the
    audit log are kept. The sample rules lose their DEMO badge and stay as starter rules (audited).
44. **The worker catches up on start.** A local app is often closed at 07:00 UTC, so start-up runs a full
    reconcile when none succeeded in 24 h, otherwise an incremental run when none succeeded in the last hour.
45. **Real-time screens hide until something can produce events.** Level 1 ships only the seam, so the
    Detections nav item, palette entry, KPI tile and drawer row appear only when `/api/realtime/status`
    reports an event source (incl. the labelled simulator) or an ingest token. The KPI slot shows Expired.

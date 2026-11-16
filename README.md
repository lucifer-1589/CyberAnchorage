# CyberAnchorage — Level 1

Enterprise threat-detection console (Wazuh / Falcon-style SOC UI, Cyber Sentinel suite).
Level 1 ingests **network IOCs** from the Dark Web CTI stores, keeps them fresh (hourly incremental,
daily full reconcile), lets analysts write rules that flag IOCs as **abnormal / suspicious / malicious**,
and ships the seam for running the same rules against real-time events.

```
CTI SQLite (read-only snapshot) → worker: normalize → merge → rules retro pass → PostgreSQL
                                               │ Redis pub/sub
React glass console ← nginx ← FastAPI API ─────┴─ matcher index (real-time seam) → detections
```

Docs: [PLAN.md](PLAN.md) (architecture, schema) · [DECISIONS.md](DECISIONS.md) (why) · [CLAUDE.md](CLAUDE.md) (working rules).

## Run it on Windows without Docker (quickest)

Needs only **Python 3.12**. Open PowerShell **in the CyberAnchorage folder** and run:

```powershell
cd D:\Emaago_work\Integeration\CyberAnchorage
powershell -ExecutionPolicy Bypass -File .\scriptsun-local.ps1
```

First run creates the Python environment (a few minutes), writes `.env` with a random JWT secret and
admin password (printed once, also saved as `ADMIN_PASSWORD` in `.env`), starts an embedded
PostgreSQL 16 on `127.0.0.1:54329` (data in `data\pg`), seeds the demo data, and opens
http://127.0.0.1:8077. One process runs the API, the hourly/daily scheduler and the UI. Ctrl+C stops everything.

Options: `-Simulator` (labelled demo detection feed) · `-Reseed` (regenerate demo data) · `-Port 9000` · `-NoBrowser`.
Rebuilding the UI after frontend changes needs Node 20 (`cd web; npm ci; npm run build`).

## Run it (docker)

```bash
cp .env.example .env            # set JWT_SECRET, ADMIN_PASSWORD (>= 10 chars), POSTGRES_PASSWORD, CTI_DATA_DIR
docker compose up -d --build    # api, worker, postgres, redis, web — all bound to 127.0.0.1
make seed-demo                  # fake CTI fixture → sync → 5 sample rules (data badged DEMO in the UI)
```

Open http://127.0.0.1:8088 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

- The real CTI folder is mounted **read-only** at `/cti`; set `CTI_DATA_DIR` in `.env` (default `../Darkweb_CTI/Darkweb_CTI`).
- `make sync` queues an incremental run; `kind=daily make sync` queues a full reconcile.
- Demo detections: set `ENABLE_SIMULATOR=true` in `.env` and `docker compose up -d api` (events are labelled *simulated*).

## Local development (no docker)

```bash
make install                    # backend venv + web node_modules
make dev-api                    # FastAPI on 127.0.0.1:8077 (needs DATABASE_URL; REDIS_URL may be empty → memory bus)
make dev-worker                 # scheduler (needs Redis for API↔worker events)
make dev-web                    # Vite on 127.0.0.1:5173, proxies /api
```

## Tests & lint

```bash
make test        # pytest (175) + vitest (7)
make lint        # ruff, mypy, eslint, tsc
```

Integration tests use `TEST_DATABASE_URL`, or start an embedded PostgreSQL 16 via the `pgserver` dev
dependency when it is unset (no docker needed).

| Requirement | Proven by |
|---|---|
| Normalization (refang, IPv6, CIDR, IDN, onion, PII drop) | `tests/unit/test_normalizer.py` |
| Merge (min/max seen, strictest TLP, unions) | `tests/unit/test_merge.py` |
| CTI never written; raw content never read | `tests/unit/test_sources.py` |
| Sync twice → no duplicates | `test_sync.py::test_sync_twice_creates_no_duplicates` |
| Changed CTI row appears within one hourly cycle | `test_sync.py::test_changed_cti_row_appears_within_one_hourly_cycle` |
| Hourly + daily jobs (07:00 UTC), reconcile, aging, one run at a time | `test_sync.py` |
| Rule evaluator incl. CIDR, suffix, NOT/NULL semantics; Python ↔ SQL parity (32 cases) | `test_rules_eval.py`, `test_rules.py` |
| Allowlisted IOC is never flagged (rules, re-eval, sync) | `test_rules.py::test_allowlisted_ioc_is_never_flagged` |
| Synthetic event matching a malicious IOC creates a Detection | `test_api_ops.py::test_synthetic_event_creates_detection` |
| RBAC, refresh-token reuse detection, rate limit, audit | `test_auth_rbac.py` |

## What's in the UI

Overview (KPIs, IOCs by type/source, flagged by verdict/severity, 30-day ingestion timeline, sync health) ·
IOC Explorer (virtualized table, URL-synced filters, saved views, detail drawer with sources timeline and
rule hits, audited reveal/copy of live values) · Rules (visual AND/OR/NOT builder, live dry-run preview,
enable/disable, version history + restore) · Flags · Allowlist (impact preview) · Sync & Sources
(store health, worker + next runs, live progress, Sync now, run history) · Detections · Audit Log ·
Users · Settings. Ctrl+K opens the command palette.

**Design:** glassmorphism tuned for readability — frosted panels stay ≥ 60 % opaque over a calm gradient
backdrop, every text colour is ≥ 4.5:1 against the glass (body text ~14:1), dark default with a light theme,
Cyber Sentinel palette (#34A99D / #458393 / #E5CB90). Severity and verdict always combine colour with an
icon, a text label and a level glyph; chart colours were validated for colour-vision deficiency.

## Stubbed / out of scope in Level 1

- **Real-time collection**: only the seam exists — `EventSource` protocol (`NullEventSource` default),
  matcher index, `POST /api/events/ingest`, `detections` table and a dev-only simulator.
- `HttpSource` is implemented and tested against a mock but **disabled by default** (only `GET /api/iocs` is allowed).
- Rate limiting is in-process (fine for one localhost API instance).
- The Docker images were not built on the development machine (no Docker there); backend tests ran
  against an embedded PostgreSQL 16, the frontend with Node 20.

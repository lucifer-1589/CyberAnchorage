# CyberAnchorage — working notes for Claude

Enterprise threat-detection console (Level 1: network-IOC intake from the Dark Web CTI + rule flagging).
Read `PLAN.md` (architecture/schema) and `DECISIONS.md` (why) before changing behaviour.

## Hard rules
- Never write to, lock, or run the CTI project. CTI SQLite files are read through a snapshot only
  (`anchorage/sources/snapshot.py`). Never call CTI routes that execute commands (`/api/tg-pty/*` etc.).
- Never store raw dark-web/Telegram content — IOC + structured metadata + source reference only.
- PII-like types (`ssn_like`, `card_like`, `iban_like`, `credential`, …) are always dropped.
- Never modify the Cyber Sentinel XDR or Dark Web CTI repos.
- Parameterized SQL only (SQLAlchemy expressions / bound params). No `eval`. Rule payloads are
  validated server-side (`anchorage/rules/schema.py`).
- Every rule / allowlist / user / settings change writes an `audit_log` row (`anchorage/core/audit.py`).
- Everything binds to `127.0.0.1` by default.

## Layout
- `backend/anchorage/` — FastAPI app (`main.py`), worker (`worker.py`), CLI (`cli.py`)
  - `ioc/` types registry + normalizer + merge · `sources/` CTI adapters · `sync/` sync service
  - `rules/` AST, validator, python + SQL compilers, engine · `realtime/` matcher index, detector, simulator
- `backend/alembic/` — migrations. Change models → `make migration m="..."`.
- `web/` — React 18 + TS + Vite. Royal Glass UI system: read `web/UI-SYSTEM.md` before UI work. Tokens in
  `web/src/styles/globals.css`, kit in `web/src/components/ui` (gallery: `/dev/ui-kit`, dev builds only),
  runtime helpers in `web/src/lib/{perf,motion}.ts`, perf tooling in `web/scripts/perf/`.

## Adding an IOC type
1. Add a normalizer + entry to `TYPE_REGISTRY` in `anchorage/ioc/types.py` (and aliases in `SOURCE_TYPE_ALIASES`).
2. If it needs a typed column for rules, extend `rules/fields.py` (both compilers) and the parity test.
3. Add normalization tests in `backend/tests/unit/test_normalizer.py`.

## Commands
- `make dev-api` / `make dev-worker` / `make dev-web` — local dev
- `make test` (backend unit + integration; integration uses `TEST_DATABASE_URL` or an embedded Postgres)
- `make lint` — ruff + mypy + eslint · `make seed-demo` — fixture CTI + sync + sample rules

## Conventions
- Async SQLAlchemy 2 style (`select()`), pydantic v2 schemas in `api/schemas.py` per router.
- Times are UTC `timestamptz`. Scores/confidence are floats 0-1.
- Frontend: TanStack Query for server state, Zustand only for UI/auth state. Toasts are 3 s.
- Colours: never use severity colour alone — always icon + label (`components/badges.tsx`).
- Glass: `Panel` defaults to G0; use `tier="g1"` only for hero surfaces (≤ 6 blurred per viewport, never
  nested, nothing that repaints inside). Animate only transform/opacity, with the `--dur-*`/`--ease-*` tokens.
- UI checks: `npm run check:contrast` (must pass), `npm run perf:run` / `perf:screens` against a preview build.

SHELL := /bin/bash
PY ?= backend/.venv/bin/python
ifeq ($(OS),Windows_NT)
PY := backend/.venv/Scripts/python
endif
COMPOSE ?= docker compose

.PHONY: help up down logs seed-demo sync test test-backend test-web lint fmt migration dev-api dev-worker dev-web install

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

up: ## Build and start the full stack (api, worker, postgres, redis, web)
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example - set JWT_SECRET and ADMIN_PASSWORD")
	$(COMPOSE) up -d --build

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail api + worker logs
	$(COMPOSE) logs -f api worker

seed-demo: ## Generate a fixture CTI SQLite set with fake IOCs, sync it, add sample rules
	$(COMPOSE) exec api python -m anchorage.cli seed-demo

sync: ## Queue a manual incremental sync (kind=daily for a full reconcile)
	$(COMPOSE) exec api python -m anchorage.cli sync --kind $${kind:-manual}

install: ## Local dev install (backend venv + web node_modules)
	python -m venv backend/.venv
	$(PY) -m pip install -e "backend[dev]"
	cd web && npm ci

test: test-backend test-web ## Run all tests

test-backend: ## pytest (integration uses TEST_DATABASE_URL or embedded postgres)
	cd backend && ../$(PY) -m pytest -q

test-web: ## Vitest
	cd web && npm run test

lint: ## ruff + mypy + eslint + tsc
	cd backend && ../$(PY) -m ruff check . && ../$(PY) -m mypy anchorage
	cd web && npm run lint && npm run typecheck

fmt: ## Format backend
	cd backend && ../$(PY) -m ruff format . && ../$(PY) -m ruff check --fix .

migration: ## Create an alembic migration: make migration m="message"
	cd backend && ../$(PY) -m alembic revision --autogenerate -m "$(m)"

dev-api: ## Run the API locally with reload
	cd backend && ../$(PY) -m uvicorn anchorage.main:app --reload --host 127.0.0.1 --port 8077

dev-worker: ## Run the worker locally
	cd backend && ../$(PY) -m anchorage.worker

dev-web: ## Run the Vite dev server
	cd web && npm run dev

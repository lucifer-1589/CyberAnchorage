"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from anchorage.api import auth, users
from anchorage.core.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from anchorage.app_lifecycle import shutdown, startup

    await startup(app)
    try:
        yield
    finally:
        await shutdown(app)


def create_app(*, with_lifespan: bool = True) -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="CyberAnchorage API",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
        lifespan=lifespan if with_lifespan else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    api = APIRouter(prefix="/api")

    @api.get("/health", tags=["meta"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for module in _routers():
        api.include_router(module.router)
    app.include_router(api)
    return app


def _routers() -> list:  # type: ignore[type-arg]
    mods = [auth, users]
    try:  # routers added in later milestones
        from anchorage.api import extra_routers

        mods.extend(extra_routers.ROUTERS)
    except ImportError:
        pass
    return mods


app = create_app()

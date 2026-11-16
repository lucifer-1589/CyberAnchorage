"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from anchorage.api import auth, detections, iocs, ops, rules, users
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
    async def security_headers(request: Request, call_next):
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

    for module in (auth, users, iocs, rules, ops, detections):
        api.include_router(module.router)
    app.include_router(api)
    if s.web_dist_dir:
        _mount_spa(app, s.web_dist_dir)
    return app


def _mount_spa(app: FastAPI, dist: str) -> None:
    """Serve the built React app (web/dist) from the API — used when there is no nginx (local mode)."""
    from pathlib import Path

    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    root = Path(dist).resolve()
    index = root / "index.html"
    if not index.exists():
        logging.getLogger("anchorage").warning("WEB_DIST_DIR %s has no index.html; UI not served", root)
        return
    app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})



app = create_app()

"""Application settings (environment driven)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# CTI store locations relative to CTI_DATA_DIR (see PLAN.md §1)
DEFAULT_CTI_STORES: dict[str, str] = {
    "crawler": "darkweb_intel/crawler.db",
    "connector": "darkweb_intel/connector.db",
    "ioc_hunter": "darkweb_intel/ioc_hunter.db",
    "telegram": "telegram-scraper/database/intel_iocs.db",
    "core": "darkweb_intel/core.db",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    environment: str = "development"
    jwt_secret: str = Field(default="", min_length=0)
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 7
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    admin_email: str = "admin@anchorage.local"
    admin_password: str = ""

    database_url: str = "postgresql+asyncpg://anchorage:anchorage@127.0.0.1:5432/anchorage"
    redis_url: str = ""

    cti_data_dir: str = "../Darkweb_CTI/Darkweb_CTI"
    cti_source_mode: str = "sqlite"  # sqlite | http | none
    cti_http_enabled: bool = False
    cti_http_base_url: str = "http://127.0.0.1:8000"
    cti_http_token: str = ""
    demo_cti_dir: str = "./data/demo-cti"
    demo_data_enabled: bool = True

    sync_hourly_minute: int = 5
    sync_daily_hour_utc: int = 7
    sync_daily_minute: int = 0
    sync_batch_size: int = 2000

    enable_simulator: bool = False
    simulator_interval_seconds: float = 8.0
    ingest_token: str = ""

    login_rate_per_minute: int = 10

    @field_validator("cti_source_mode")
    @classmethod
    def _mode(cls, v: str) -> str:
        if v not in {"sqlite", "http", "none"}:
            raise ValueError("CTI_SOURCE_MODE must be sqlite|http|none")
        return v

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    def cti_store_paths(self, root: str | None = None) -> dict[str, Path]:
        base = Path(root or self.cti_data_dir)
        return {k: base / rel for k, rel in DEFAULT_CTI_STORES.items()}

    def effective_jwt_secret(self) -> str:
        if self.jwt_secret and self.jwt_secret != "change-me-to-a-long-random-string":  # noqa: S105
            return self.jwt_secret
        if self.is_production:
            raise RuntimeError("JWT_SECRET must be set in production")
        # Dev fallback: stable per-process secret so tokens work until restart.
        return _dev_secret()


@lru_cache
def _dev_secret() -> str:
    import secrets

    return secrets.token_urlsafe(48)


@lru_cache
def get_settings() -> Settings:
    return Settings()

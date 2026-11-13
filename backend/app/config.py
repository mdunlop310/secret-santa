from functools import lru_cache
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


DEV_SECRET_KEY = "dev-only-not-secret"  # noqa: S105 - rejected outside development below


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    # "development" or "production" (staging counts as production).
    environment: str = "development"

    database_url: str = "postgresql+psycopg://santa:santa@localhost:5432/santa"
    # Neon's direct (unpooled) URL, as `neon env pull` names it. Used for migrations,
    # which can't go through the pooler; falls back to DATABASE_URL when unset.
    database_url_unpooled: str | None = None
    # False on serverless hosts (Vercel): open a connection per request and let the
    # database's own pooler (Neon's PgBouncer) do the pooling.
    database_pooling: bool = True
    app_base_url: str = "http://localhost:5173"
    # Public URL of this API, used for one-click unsubscribe headers in emails.
    api_base_url: str = "http://localhost:8000"
    # Signs unsubscribe links. Must be set to a long random value in production.
    secret_key: str = DEV_SECRET_KEY
    # Bearer token for POST /internal/jobs/run. Empty disables the endpoint.
    cron_secret: str = ""
    cors_origins: str = "http://localhost:5173"

    email_backend: str = "console"
    email_from: str = "Secret Santa <santa@localhost>"
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    resend_api_key: str = ""

    rate_limit_group_create: int = 10
    rate_limit_email_send: int = 20
    rate_limit_link_preview: int = 60
    rate_limit_draw: int = 10
    rate_limit_codeword: int = 60
    # How many reverse proxies sit in front of the API (1 on Render). The client IP for
    # rate limits is read that many entries from the right of X-Forwarded-For, so a
    # client can't dodge limits by sending its own header. 0 trusts no header.
    trusted_proxy_hops: int = 0

    @field_validator("database_url", "database_url_unpooled")
    @classmethod
    def _use_psycopg(cls, url: str | None) -> str | None:
        # Hosts hand out postgres:// or postgresql:// URLs; SQLAlchemy needs the driver.
        for prefix in ("postgres://", "postgresql://"):
            if url and url.startswith(prefix):
                return "postgresql+psycopg://" + url.removeprefix(prefix)
        return url

    @model_validator(mode="after")
    def _require_real_secrets(self) -> "Settings":
        if self.environment != "development":
            if self.secret_key == DEV_SECRET_KEY or len(self.secret_key) < 32:
                raise ValueError("SECRET_KEY must be set to a long random value")
            if self.email_backend == "console":
                raise ValueError("EMAIL_BACKEND must be smtp or resend outside development")
        return self

    @property
    def migration_database_url(self) -> str:
        return self.database_url_unpooled or self.database_url

    @property
    def uses_pgbouncer(self) -> bool:
        """Neon's pooled hosts end in -pooler and run PgBouncer in transaction mode."""
        host = self.database_url.split("@", 1)[-1].split("/", 1)[0].split(":", 1)[0]
        return host.split(".", 1)[0].endswith("-pooler")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

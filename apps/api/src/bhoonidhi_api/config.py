"""Backend settings, loaded from apps/api/.env. Secrets stay here, never logged."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Any OpenAI-compatible server: LM Studio, Ollama, llama.cpp, vLLM or
    # OpenAI itself. The key is a secret; local servers usually need none.
    openai_base_url: str = "http://localhost:1234/v1"
    openai_api_key: str = ""
    openai_model: str = "openai/gpt-oss-20b"
    frontend_origin: str = "http://localhost:3000"

    # The line for the model (model_queue.py). Questions the model answers at
    # once: match the model server's own limit (LM Studio's `parallel`).
    model_slots: int = 4
    # Questions that may wait for a place; past this a new one is refused.
    model_queue_max: int = 20
    # Longest a question waits for a place before it is dropped.
    model_queue_wait_s: float = 180

    # stac-fastapi service over the pgSTAC catalogue, e.g. http://localhost:8004.
    # The only scene source. Empty leaves the agent able to look up places but
    # not to search scenes.
    stac_api_url: str = ""

    # SQLite file holding conversations; created on first start.
    sessions_db: str = "data/sessions.db"
    # A conversation is deleted this many days after its last activity (a
    # question, a query, a rename). 0 keeps conversations forever.
    conversation_retention_days: float = 7

    # Which header holds the visitor's address, for the per-visitor limits.
    # Set it only when every request passes through a proxy that writes the
    # header itself (Cf-Connecting-Ip behind Cloudflare); on a request that
    # does not, a visitor can send any header. Empty uses the connection's
    # address, which uvicorn takes from X-Forwarded-For only when the request
    # comes from a proxy listed in FORWARDED_ALLOW_IPS.
    client_ip_header: str = ""

    # Place search (@ in the palette). Nominatim's policy requires a
    # User-Agent naming the app, and a way to switch servers without a release.
    geocoder_url: str = "https://nominatim.openstreetmap.org"
    geocoder_user_agent: str = "bhoonidhi-explorer/0.1"


settings = Settings()

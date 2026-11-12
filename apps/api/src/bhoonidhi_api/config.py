"""Backend settings, loaded from apps/api/.env. Secrets stay here, never logged."""
import json
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Which model answers questions: "openai" for any OpenAI-compatible
    # server (the OPENAI_* settings), "anthropic" for Claude through
    # Anthropic's own API (the ANTHROPIC_* settings).
    model_provider: Literal["openai", "anthropic"] = "openai"

    # Any OpenAI-compatible server: LM Studio, Ollama, llama.cpp, vLLM or
    # OpenAI itself. The key is a secret; local servers usually need none.
    openai_base_url: str = "http://localhost:1234/v1"
    openai_api_key: str = ""
    openai_model: str = "openai/gpt-oss-20b"
    # Sent with every request; empty leaves the temperature to the server.
    openai_temperature: str = "0"
    # Extra fields for every request, as a JSON object: for example
    # {"reasoning_effort": "none"} to turn a local model's thinking off.
    openai_extra_body: str = ""

    # Claude through Anthropic's Messages API. The key is a secret.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-5-5"
    # How hard the model works on each step; empty uses the model's default.
    anthropic_effort: Literal["", "low", "medium", "high", "xhigh", "max"] = ""
    # "disabled" turns thinking off, "adaptive" lets the model decide, and
    # "between_tools" thinks only between tool calls, on the models that
    # accept each; empty uses the model's default.
    anthropic_thinking: Literal["", "adaptive", "disabled", "between_tools"] = ""
    # The most one step may write, thinking included.
    anthropic_max_tokens: int = 4096
    # How long the start of a request (tools, instructions, the conversation
    # so far) stays cached for the next step: "5m", "1h" (writes cost twice
    # as much) or "off".
    anthropic_cache_ttl: Literal["5m", "1h", "off"] = "5m"
    # Tool arguments always match the tool's schema. Off by default: on
    # Haiku 5.5 it made the model leave the place's box out of 12 of 50
    # searches for a named place (Nov 2026), which then covered all of India.
    anthropic_strict_tools: bool = False
    # Another address for Anthropic's API, such as a gateway; empty uses Anthropic's.
    anthropic_base_url: str = ""

    # Who answers when MODEL_PROVIDER fails (no connection, no first byte in
    # time, overloaded, rate limited, out of credit, a bad key, or a budget
    # below reached): the other provider, or empty for nobody. The answer in
    # progress carries on with it.
    model_fallback: Literal["", "openai", "anthropic"] = ""
    # After a failure, how long new questions go straight to the fallback
    # before MODEL_PROVIDER is tried again.
    model_fallback_cooldown_s: float = 300
    # With a fallback set: MODEL_PROVIDER failing to send anything for this
    # long counts as a failure. Without one, the SDKs' own limits apply.
    model_first_token_timeout_s: float = 20
    # The app's own spend ceilings in US dollars, per UTC day and calendar
    # month, counted from each answer's token usage; past one, the fallback
    # answers until the day or month ends. 0 is no ceiling.
    model_budget_daily_usd: float = 0
    model_budget_monthly_usd: float = 0
    # Prices the budget uses, in US dollars per million tokens, as JSON over
    # the built-in table (usage.py): {"model-id": {"in": 0.1, "write": 0.125,
    # "write_1h": 0.2, "read": 0.01, "out": 0.5}}.
    model_prices: str = ""
    # Memory: each earlier tool result is replayed cut to this many characters,
    # and only the last MODEL_HISTORY_TURNS turns are replayed whole (older
    # ones keep the question and the answer). 0 replays every turn whole.
    model_memory_result_chars: int = 4000
    model_history_turns: int = 0

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
    # The same STAC API at the address visitors' browsers reach, for the
    # scene card's link to each item. Set it when STAC_API_URL is an address
    # only this server reaches; empty uses STAC_API_URL.
    stac_public_url: str = ""

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

    # A typo in these two should stop the server at start, not fail a visitor's question.
    @field_validator("openai_temperature")
    @classmethod
    def _temperature_is_a_number(cls, value: str) -> str:
        value = value.strip()
        if value:
            float(value)
        return value

    @field_validator("openai_extra_body")
    @classmethod
    def _extra_body_is_an_object(cls, value: str) -> str:
        value = value.strip()
        if value and not isinstance(json.loads(value), dict):
            raise ValueError("OPENAI_EXTRA_BODY must be a JSON object")
        return value

    @field_validator("model_prices")
    @classmethod
    def _prices_are_a_table(cls, value: str) -> str:
        value = value.strip()
        if value:
            table = json.loads(value)
            keys = {"in", "write", "write_1h", "read", "out"}
            if not isinstance(table, dict) or not all(
                isinstance(p, dict) and keys <= p.keys() and all(isinstance(p[k], int | float) for k in keys)
                for p in table.values()
            ):
                raise ValueError(f"MODEL_PRICES must map model ids to {sorted(keys)} in USD per million tokens")
        return value

    @model_validator(mode="after")
    def _models_are_usable(self) -> "Settings":
        if self.model_fallback == self.model_provider:
            raise ValueError("MODEL_FALLBACK must be the other provider, or empty")
        for provider in {self.model_provider, self.model_fallback} - {""}:
            if provider == "openai" and not self.openai_base_url.strip():
                raise ValueError("OPENAI_BASE_URL is empty, and the openai provider needs it")
            if provider == "openai" and not self.openai_model.strip():
                raise ValueError("OPENAI_MODEL is empty, and the openai provider needs it")
            if provider == "anthropic" and not self.anthropic_api_key.strip():
                raise ValueError("ANTHROPIC_API_KEY is empty, and the anthropic provider needs it")
        return self


settings = Settings()

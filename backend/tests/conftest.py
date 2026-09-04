"""All tests run in an environment with no OpenAI key (rule-based / simulated paths); a key in the local .env does not cause a real API call."""
import os
import pytest


@pytest.fixture(autouse=True)
def _no_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    yield


@pytest.fixture(autouse=True)
def _guard_defaults(monkeypatch):
    """Tests disable the rate limit and the Origin check by default (individual tests turn them on)."""
    from app.guard import limiter
    monkeypatch.setenv("TWIN_RATE_LIMIT", "0")
    monkeypatch.delenv("TWIN_CORS_ORIGINS", raising=False)
    monkeypatch.delenv("TWIN_CORS_REGEX", raising=False)
    limiter.reset()
    yield
    limiter.reset()

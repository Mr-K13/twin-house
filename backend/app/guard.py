"""
Protection layer for the public demo (batch 2 review fixes)

  - Origin check: when TWIN_CORS_ORIGINS / TWIN_CORS_REGEX is set, WebSocket connections and POST requests that change state
    must send an allowed Origin (a browser always sends one; curl without one -> reject, unless TWIN_ALLOW_NO_ORIGIN=1).
    When not set (local development, default "*"), no check occurs.
  - Rate limit: in-memory sliding window, one bucket per client IP (behind Render, from X-Forwarded-For):
        mutate  inject / clear / create task / play, pause, reset      20 calls / minute
        ai      Copilot / VLM                           10 calls / minute
        whatif  What-if                                  4 calls / minute
        ws      total messages per WebSocket connection                120 calls / minute
    TWIN_RATE_LIMIT=0 turns it off (tests / local development).
  - Body size limit: REST 512 KB (counted as real bytes at the ASGI receive layer), WS 64 KB per message (UTF-8 bytes).
  - Task locations: app/sim/rules.py validates them (they exist, are not a charger, are different, and match the TaskType).
"""
from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque
from typing import Deque

MAX_BODY_BYTES = 512 * 1024
MAX_WS_MESSAGE_BYTES = 64 * 1024

LIMITS: dict[str, tuple[int, float]] = {   # bucket → (max calls, window seconds)
    "mutate": (20, 60.0),
    "ai": (10, 60.0),
    "whatif": (4, 60.0),
    "ws": (120, 60.0),
}


def rate_limit_enabled() -> bool:
    return os.environ.get("TWIN_RATE_LIMIT", "1") != "0"


class RateLimiter:
    GC_EVERY = 500   # Every N checks, remove expired keys. Then many different IPs do not stay in memory forever.

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], Deque[float]] = defaultdict(deque)
        self._calls = 0

    def _gc(self, now: float) -> None:
        dead = [k for k, q in self._hits.items() if not q or now - q[-1] > LIMITS[k[0]][1]]
        for k in dead:
            del self._hits[k]

    def check(self, bucket: str, key: str) -> tuple[bool, float]:
        """Return (allowed?, seconds to wait)."""
        if not rate_limit_enabled():
            return True, 0.0
        limit, window = LIMITS[bucket]
        now = time.monotonic()
        self._calls += 1
        if self._calls % self.GC_EVERY == 0:
            self._gc(now)
        q = self._hits[(bucket, key)]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return False, round(window - (now - q[0]), 1) if q else window
        q.append(now)
        return True, 0.0

    def reset(self) -> None:
        self._hits.clear()


limiter = RateLimiter()


def client_key(headers: dict[str, str] | None, host: str | None) -> str:
    """The reverse proxy (Render) **appends** the real client IP to the end of X-Forwarded-For; fake values from the client come first.
    Thus take the entry at position TWIN_TRUSTED_PROXIES from the end (default 1 = the last entry, the connection that the proxy saw itself).
    TWIN_TRUSTED_PROXIES=0 = do not trust the header; use the connection source directly (local development)."""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    n = int(os.environ.get("TWIN_TRUSTED_PROXIES", "1"))
    xff = h.get("x-forwarded-for")
    if xff and n > 0:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-n] if len(parts) >= n else parts[0]
    return host or "unknown"


def _allowed_origins() -> tuple[list[str], re.Pattern[str] | None, bool]:
    raw = os.environ.get("TWIN_CORS_ORIGINS", "*")
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    regex = os.environ.get("TWIN_CORS_REGEX") or None
    open_ = "*" in origins and not regex
    return origins, re.compile(regex) if regex else None, open_


def origin_allowed(origin: str | None) -> bool:
    origins, regex, open_ = _allowed_origins()
    if open_:
        return True
    if not origin:
        return os.environ.get("TWIN_ALLOW_NO_ORIGIN", "0") == "1"
    o = origin.rstrip("/")
    if o in origins:
        return True
    return bool(regex and regex.fullmatch(o))

#!/usr/bin/env bash
# Start the backend + frontend with one command (macOS / Linux).
# Windows PowerShell users: run dev.ps1 instead.
#
#   ./dev.sh                  start both, stream both logs, Ctrl+C stops both
#   BACKEND_PORT=9000 ./dev.sh
#   NO_INSTALL=1 ./dev.sh     skip the dependency bootstrap
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
# Bind dual-stack: the browser resolves "localhost" to ::1 first, so an
# IPv4-only bind makes the WebSocket fail and the UI falls back to LOCAL.
BACKEND_HOST="${BACKEND_HOST:-::}"
VENV="$ROOT/backend/.venv"
PY="$VENV/bin/python"

log()  { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[dev] %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || die "python3 not found"
command -v npm     >/dev/null 2>&1 || die "npm not found (Node 18+ required)"

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    die "port $port is already in use. Stop that process, or set BACKEND_PORT / FRONTEND_PORT."
  fi
done

# ── dependencies ─────────────────────────────────────────────────────────
if [ -z "${NO_INSTALL:-}" ]; then
  if [ ! -x "$PY" ]; then
    log "creating backend venv (backend/.venv)"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet -r "$ROOT/backend/requirements.txt"
  elif ! "$PY" -c 'import websockets' >/dev/null 2>&1; then
    # Without the websockets package uvicorn answers /ws with 404 and the only
    # clue is a startup warning, so check for it explicitly.
    log "backend venv is incomplete, installing requirements"
    "$VENV/bin/pip" install --quiet -r "$ROOT/backend/requirements.txt"
  fi

  if [ ! -d "$ROOT/frontend/node_modules" ]; then
    log "installing frontend dependencies"
    ( cd "$ROOT/frontend" && npm install )
  fi
fi

[ -x "$PY" ] || die "backend venv missing. Re-run without NO_INSTALL=1."

# ── run ──────────────────────────────────────────────────────────────────
BACK_PID=""
FRONT_PID=""
INTERRUPTED=""

cleanup() {
  trap - INT TERM EXIT
  echo
  log "shutting down"
  for pid in "$FRONT_PID" "$BACK_PID"; do
    [ -n "$pid" ] || continue
    pkill -P "$pid" >/dev/null 2>&1 || true   # uvicorn --reload / npm spawn children
    kill "$pid"     >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}
on_signal() { INTERRUPTED=1; cleanup; exit 0; }
trap on_signal INT TERM
trap cleanup EXIT

prefix() { local tag="$1" color="$2"; while IFS= read -r line; do printf '\033[%sm%-8s\033[0m %s\n' "$color" "$tag" "$line"; done; }

( cd "$ROOT/backend" && exec "$PY" -m uvicorn app.main:app --reload \
    --port "$BACKEND_PORT" --host "$BACKEND_HOST" ) \
  > >(prefix backend '1;34') 2>&1 &
BACK_PID=$!
disown "$BACK_PID" 2>/dev/null || true

# The frontend defaults to ws://<host>:8000/ws (services/ws.ts). On a non-default
# backend port it must be told explicitly, or the UI falls back to LOCAL.
if [ "$BACKEND_PORT" != "8000" ] && [ -z "${VITE_WS_URL:-}" ]; then
  export VITE_WS_URL="ws://localhost:$BACKEND_PORT/ws"
  log "frontend will use VITE_WS_URL=$VITE_WS_URL"
fi

( cd "$ROOT/frontend" && exec npm run dev -- --port "$FRONTEND_PORT" --strictPort ) \
  > >(prefix frontend '1;32') 2>&1 &
FRONT_PID=$!
disown "$FRONT_PID" 2>/dev/null || true

# ── wait for the backend, then report ────────────────────────────────────
ready=""
for _ in $(seq 1 80); do
  if curl -fsS "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$BACK_PID" 2>/dev/null || break
  sleep 0.5
done

echo
if [ -n "$ready" ]; then
  log "backend   http://localhost:$BACKEND_PORT       (health: /api/health)"
else
  warn "backend did not answer /api/health yet - see the log above"
fi
log "frontend  http://localhost:$FRONTEND_PORT"
log "Ctrl+C stops both."
echo

# Exit as soon as either side dies, so a crash is not left half-running.
while kill -0 "$BACK_PID" 2>/dev/null && kill -0 "$FRONT_PID" 2>/dev/null; do
  sleep 1
done
[ -n "$INTERRUPTED" ] || warn "one process exited - stopping the other"

# Shared setup for start.sh, stop.sh, restart.sh and refresh.sh. Not run directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Settings come from .env when it exists (see .env.example), then from the environment.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-3457}"
SERVER_ENTRY="${SERVER_ENTRY:-server/site.ts}"
PID_FILE="$ROOT/data/run/server.pid"
LOG_FILE="$ROOT/logs/server.log"
export PORT

# PID of our server if it's running, else empty.
server_pid() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q "node"; then
    echo "$pid"
  else
    rm -f "$PID_FILE"
  fi
}

port_busy() {
  curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"
}

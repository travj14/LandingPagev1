#!/usr/bin/env bash
# Start the server in the background. Logs go to logs/server.log.
source "$(dirname "$0")/scripts/common.sh"

if pid="$(server_pid)" && [[ -n "$pid" ]]; then
  echo "Already running (pid $pid) on http://localhost:$PORT. Use ./restart.sh to restart."
  exit 0
fi
if port_busy; then
  echo "Port $PORT is already in use by another process. Stop it first, or set PORT in .env." >&2
  exit 1
fi

# The server runs TypeScript directly, which needs Node 23.6 or newer.
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)'; then
  echo "Node $(node -v) is too old. Install Node 23.6 or newer." >&2
  exit 1
fi

# Install dependencies when they're missing or package-lock.json changed.
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "Installing dependencies…"
  npm ci --no-audit --no-fund
fi

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting $SERVER_ENTRY on port $PORT ===" >> "$LOG_FILE"
nohup node "$SERVER_ENTRY" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# Wait until it answers (the first start can take a while to load history).
for _ in $(seq 1 60); do
  if port_busy; then
    echo "Started (pid $(cat "$PID_FILE")) on http://localhost:$PORT. Logs: logs/server.log"
    exit 0
  fi
  if [[ -z "$(server_pid)" ]]; then
    echo "Server exited during startup. Last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done
echo "Server is running (pid $(cat "$PID_FILE")) but not answering yet. Check logs/server.log." >&2
exit 1

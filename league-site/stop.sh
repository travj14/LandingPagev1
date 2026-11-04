#!/usr/bin/env bash
# Stop the server started by start.sh.
source "$(dirname "$0")/scripts/common.sh"

pid="$(server_pid)"
if [[ -z "$pid" ]]; then
  echo "Not running."
  exit 0
fi

kill "$pid"
for _ in $(seq 1 10); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  echo "Didn't stop after 10s, forcing it."
  kill -9 "$pid"
fi
rm -f "$PID_FILE"
echo "Stopped (pid $pid)."

#!/usr/bin/env bash
# Restart the server, e.g. after an update.
#   ./restart.sh          restart with the code as it is
#   ./restart.sh --pull   git pull the latest code first (works from inside any git repo, e.g. once this folder is in your main repo)
source "$(dirname "$0")/scripts/common.sh"

if [[ "${1:-}" == "--pull" ]]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "--pull needs a git repo, and this folder isn't in one yet." >&2
    exit 1
  fi
  git pull --ff-only
fi

"$ROOT/stop.sh"
"$ROOT/start.sh"

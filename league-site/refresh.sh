#!/usr/bin/env bash
# Force a full re-download of all league history from Sleeper.
# The running server swaps in the new data. If the server isn't running,
# the disk cache is refreshed so the next start is up to date.
source "$(dirname "$0")/scripts/common.sh"

node server/refresh-cli.ts

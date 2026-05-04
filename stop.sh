#!/usr/bin/env bash
# stop.sh — gracefully stops all HITL-CDT services that were started by start.sh.
#
# Usage:
#   ./stop.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/logs/pids.txt"

echo ""
echo "Stopping all HITL-CDT services ..."
echo ""

if [ ! -f "$PID_FILE" ]; then
  fail "No PID file found at logs/pids.txt. Were services started with ./start.sh?"
  exit 1
fi

# Read each PID and send SIGTERM (kill default signal).
# Then wait for the process to exit; if it doesn't die within 5s, force-kill it.
while IFS= read -r pid; do
  if [ -z "$pid" ]; then continue; fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    # Wait up to 5 seconds for the process to exit.
    for i in $(seq 1 5); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    # Force kill if still running.
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
      ok "Force-killed PID $pid"
    else
      ok "Stopped PID $pid"
    fi
  else
    echo "  PID $pid was already stopped."
  fi
done < "$PID_FILE"

# Clear the PID file so a subsequent ./stop.sh is a no-op.
> "$PID_FILE"

echo ""
ok "All done."
echo ""

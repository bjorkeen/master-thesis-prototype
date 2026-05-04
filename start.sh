#!/usr/bin/env bash
# start.sh — starts all 5 HITL-CDT services and checks they are healthy.
#
# Services started (in order):
#   1. ML Service      — Python FastAPI on port 8001
#   2. Twin Service    — Python FastAPI on port 8002
#   3. Decision Service— Python FastAPI on port 8003
#   4. API Gateway     — Node.js Express + Socket.io on port 4000
#   5. Frontend        — React + Vite dev server on port 5173
#
# Logs are written to logs/<service>.log in the project root.
# PIDs are saved to logs/pids.txt so stop.sh can kill them cleanly.
#
# Usage:
#   chmod +x start.sh   # only needed once
#   ./start.sh

# ── helpers ──────────────────────────────────────────────────────────────────

# Colour codes for readable output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WAIT]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

# wait_for_port <port> <service-name> <max-seconds>
# Polls http://localhost:<port>/health every second until it returns HTTP 200
# or until the timeout is reached.
wait_for_port() {
  local port=$1
  local name=$2
  local max=$3
  local elapsed=0

  warn "Waiting for $name on port $port ..."
  while [ $elapsed -lt $max ]; do
    # -s = silent, -o /dev/null = discard body, -w = write HTTP status code
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/health" 2>/dev/null)
    if [ "$status" = "200" ]; then
      ok "$name is up (port $port)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  fail "$name did NOT become healthy within ${max}s — check logs/$name.log"
  return 1
}

# ── setup ─────────────────────────────────────────────────────────────────────

# Always run from the project root no matter where the script is called from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Create a logs/ directory to keep stdout/stderr for each service.
mkdir -p logs

# Clear any previous PID file so stop.sh always has a fresh list.
> logs/pids.txt

echo ""
echo "═══════════════════════════════════════════════════"
echo "  HITL-CDT — starting all services"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Python virtual environment ────────────────────────────────────────────────

PYTHON=".venv/bin/python3"
UVICORN=".venv/bin/uvicorn"

if [ ! -f "$PYTHON" ]; then
  fail "Virtual environment not found at .venv/. Run:"
  echo "  python3 -m venv .venv"
  echo "  .venv/bin/pip install -r services/ml-service/requirements.txt"
  echo "  .venv/bin/pip install -r services/twin-service/requirements.txt"
  echo "  .venv/bin/pip install -r services/decision-service/requirements.txt"
  exit 1
fi

# ── 1. ML Service (port 8001) ─────────────────────────────────────────────────

echo "Starting ML Service (port 8001) ..."
# --app-dir tells uvicorn where the Python file lives.
# We run from the project root so relative paths to data/ and config/ work inside main.py.
"$UVICORN" main:app \
  --app-dir services/ml-service \
  --host 0.0.0.0 \
  --port 8001 \
  --log-level info \
  > logs/ml-service.log 2>&1 &
echo $! >> logs/pids.txt

# ── 2. Twin Service (port 8002) ───────────────────────────────────────────────

echo "Starting Twin Service (port 8002) ..."
"$UVICORN" main:app \
  --app-dir services/twin-service \
  --host 0.0.0.0 \
  --port 8002 \
  --log-level info \
  > logs/twin-service.log 2>&1 &
echo $! >> logs/pids.txt

# ── 3. Decision Service (port 8003) ───────────────────────────────────────────

echo "Starting Decision Service (port 8003) ..."
"$UVICORN" main:app \
  --app-dir services/decision-service \
  --host 0.0.0.0 \
  --port 8003 \
  --log-level info \
  > logs/decision-service.log 2>&1 &
echo $! >> logs/pids.txt

# ── 4. API Gateway (port 4000) ────────────────────────────────────────────────

echo "Starting API Gateway (port 4000) ..."
# node_modules is inside gateway/, so we cd there so that 'node index.js' finds them.
(cd gateway && node index.js > ../logs/gateway.log 2>&1) &
echo $! >> logs/pids.txt

# ── 5. Frontend dev server (port 5173) ────────────────────────────────────────

echo "Starting Frontend dev server (port 5173) ..."
(cd frontend && npm run dev > ../logs/frontend.log 2>&1) &
echo $! >> logs/pids.txt

echo ""
echo "All processes launched. Waiting for health checks ..."
echo ""

# ── Health checks ─────────────────────────────────────────────────────────────

# Give each Python service up to 30 seconds, the others up to 20 seconds.
# The ML service loads a RandomForest + SHAP, so it may take a few extra seconds.

all_ok=true

wait_for_port 8001 "ml-service"      30 || all_ok=false
wait_for_port 8002 "twin-service"    20 || all_ok=false
wait_for_port 8003 "decision-service" 20 || all_ok=false

# The gateway has a /health endpoint too — check it.
wait_for_port 4000 "gateway"         20 || all_ok=false

# Vite exposes no /health endpoint; we just wait for port 5173 to accept connections.
echo ""
warn "Waiting for Frontend (Vite) on port 5173 ..."
elapsed=0
while [ $elapsed -lt 20 ]; do
  # Try a TCP connection; curl will return non-200 but the port being open is enough.
  if curl -s --max-time 1 "http://localhost:5173" > /dev/null 2>&1; then
    ok "Frontend is up (port 5173)"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
if [ $elapsed -ge 20 ]; then
  fail "Frontend did NOT start within 20s — check logs/frontend.log"
  all_ok=false
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
if $all_ok; then
  ok "All services are running!"
  echo ""
  echo "  ML Service       → http://localhost:8001/docs"
  echo "  Twin Service     → http://localhost:8002/docs"
  echo "  Decision Service → http://localhost:8003/docs"
  echo "  API Gateway      → http://localhost:4000"
  echo "  Frontend         → http://localhost:5173"
  echo ""
  echo "  Logs are in: $SCRIPT_DIR/logs/"
  echo "  To stop everything: ./stop.sh"
else
  fail "One or more services failed to start. Check the logs above."
  echo "  Logs are in: $SCRIPT_DIR/logs/"
fi
echo "═══════════════════════════════════════════════════"
echo ""

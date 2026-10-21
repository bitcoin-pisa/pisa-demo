#!/usr/bin/env bash
# Start and stop the whole demo: the wallet server (which runs the BIP 460
# regtest node and the payjoin directory), and the mempool explorer pointed at
# that node.
#
#   scripts/demo.sh start [--fresh]   start everything, --fresh for a new chain
#   scripts/demo.sh stop              stop everything
#   scripts/demo.sh status            what is running
#   scripts/demo.sh logs [name]       follow a log: wallets, mempool-api, mempool-web
set -euo pipefail

DEMO="$(cd "$(dirname "$0")/.." && pwd)"
# Where the other checkouts are, see README.md. Each can be set on its own.
SRC="${SRC:-$DEMO/../src}"
BITCOIND_EXE="${BITCOIND_EXE:-$SRC/bitcoin/build/bin/bitcoind}"
MEMPOOL="${MEMPOOL:-$SRC/mempool}"
# A folder with the node mempool pins (24.13), put first on PATH; without it
# whatever node is on PATH runs mempool.
NODE_BIN="${NODE_BIN:-$DEMO/../tools/node-v24.13.0-darwin-arm64/bin}"
RUN="$DEMO/.data/run"
LOGS="$DEMO/.data/logs"
WALLET_PORT="${WALLET_PORT:-3000}"
EXPLORER_PORT="${EXPLORER_PORT:-4200}"
PACE_MS="${PACE_MS:-1100}"

[[ -d "$NODE_BIN" ]] && export PATH="$NODE_BIN:$PATH"
mkdir -p "$RUN" "$LOGS"

running() { [[ -f "$RUN/$1.pid" ]] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

wait_http() {
  local url=$1 name=$2 tries=${3:-120}
  for _ in $(seq "$tries"); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  echo "  $name did not come up; see $LOGS/$name.log" >&2
  return 1
}

start_wallets() {
  local fresh=$1
  if running wallets; then echo "  wallets already running"; return; fi
  [[ -x "$BITCOIND_EXE" ]] || { echo "no bitcoind at $BITCOIND_EXE; build bitcoin-pisa/bitcoin's bip460 branch, see README.md" >&2; exit 1; }
  [[ -d "$MEMPOOL/backend/dist" ]] || { echo "no built mempool at $MEMPOOL; see README.md" >&2; exit 1; }
  (cd "$DEMO" && cargo build -q --release)
  # The explorer's backend caches what it has seen; a new chain needs it gone.
  [[ -n "$fresh" ]] && rm -rf "$DEMO/.data/mempool-cache"
  "$DEMO/target/release/pisa-demo" --bitcoind "$BITCOIND_EXE" $fresh \
    --port "$WALLET_PORT" --explorer "http://localhost:$EXPLORER_PORT" --pace-ms "$PACE_MS" \
    < /dev/null > "$LOGS/wallets.log" 2>&1 &
  echo $! > "$RUN/wallets.pid"
  wait_http "http://localhost:$WALLET_PORT/api/state" wallets 90
  echo "  wallets      http://localhost:$WALLET_PORT"
}

start_mempool_api() {
  if running mempool-api; then echo "  mempool api already running"; return; fi
  mkdir -p "$DEMO/.data/mempool-cache"
  (cd "$MEMPOOL/backend" && MEMPOOL_CONFIG_FILE="$DEMO/config/mempool-backend.json" \
    exec node --max-old-space-size=2048 dist/index.js < /dev/null > "$LOGS/mempool-api.log" 2>&1) &
  echo $! > "$RUN/mempool-api.pid"
  wait_http "http://localhost:8999/api/v1/blocks/tip/height" mempool-api 60
  echo "  mempool api  http://localhost:8999"
}

start_mempool_web() {
  if running mempool-web; then echo "  explorer already running"; return; fi
  cp "$DEMO/config/mempool-frontend.json" "$MEMPOOL/frontend/mempool-frontend-config.json"
  (cd "$MEMPOOL/frontend" && exec npm run serve -- --port "$EXPLORER_PORT" < /dev/null > "$LOGS/mempool-web.log" 2>&1) &
  echo $! > "$RUN/mempool-web.pid"
  wait_http "http://localhost:$EXPLORER_PORT/" mempool-web 300
  echo "  explorer     http://localhost:$EXPLORER_PORT"
}

# A process and everything below it: npm starts a shell, which starts ng.
tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid"); do tree "$child"; done
  echo "$pid"
}

stop_one() {
  local name=$1
  if running "$name"; then
    local pid; pid=$(cat "$RUN/$name.pid")
    # Leaves first, so nothing respawns; the wallet server stops bitcoind
    # itself on SIGTERM, so it gets only the one signal.
    if [[ "$name" == wallets ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    else
      for p in $(tree "$pid"); do kill -TERM "$p" 2>/dev/null || true; done
    fi
    for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$pid" 2>/dev/null || true
    echo "  stopped $name"
  fi
  rm -f "$RUN/$name.pid"
}

# The wallet server stops its node on the way out. If it was killed hard,
# the node is still there and would block the next start.
stop_stray_node() {
  local cli="${BITCOIND_EXE%/bitcoind}/bitcoin-cli"
  if pgrep -f "bitcoind.*-datadir=$DEMO/.data/bitcoin" > /dev/null; then
    "$cli" -regtest -rpcport=18443 -rpcuser=pisa -rpcpassword=pisa stop > /dev/null 2>&1 || true
    for _ in $(seq 50); do pgrep -f "bitcoind.*-datadir=$DEMO/.data/bitcoin" > /dev/null || break; sleep 0.2; done
    echo "  stopped a leftover bitcoind"
  fi
}

case "${1:-}" in
  start)
    fresh=""
    [[ "${2:-}" == "--fresh" ]] && fresh="--fresh"
    running wallets || stop_stray_node
    start_wallets "$fresh"
    start_mempool_api
    start_mempool_web
    ;;
  stop)
    stop_one mempool-web
    stop_one mempool-api
    stop_one wallets
    stop_stray_node
    ;;
  restart)
    "$0" stop
    "$0" start "${2:-}"
    ;;
  status)
    for name in wallets mempool-api mempool-web; do
      if running "$name"; then echo "  $name running (pid $(cat "$RUN/$name.pid"))"; else echo "  $name stopped"; fi
    done
    ;;
  logs)
    tail -f "$LOGS/${2:-wallets}.log"
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac

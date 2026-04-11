#!/usr/bin/env bash
# doItAll.sh — One-shot local setup for initRoot
#
# What it does:
#   1. Checks prerequisites
#   2. Installs pnpm dependencies
#   3. Starts the Initia pillow-rollup EVM chain (via weave)
#   4. Deploys all contracts (Agent, iUSD demo, MockPerpDEX)
#   5. Writes .env and apps/api/.dev.vars from deployed addresses
#   6. Applies local Cloudflare D1 migrations
#   7. Starts the API (port 8787) and Web (port 3001)
#
# Flags:
#   --skip-chain      Skip starting the chain (if already running)
#   --skip-contracts  Skip contract deployment (use addresses already in apps/web/.env)
#
# Usage:
#   chmod +x doItAll.sh
#   ./doItAll.sh
#   ./doItAll.sh --skip-chain
#   ./doItAll.sh --skip-chain --skip-contracts

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[•]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════╗"
echo "║   initRoot — doItAll local setup         ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_CHAIN=false
SKIP_CONTRACTS=false

for arg in "$@"; do
  case $arg in
    --skip-chain)     SKIP_CHAIN=true ;;
    --skip-contracts) SKIP_CONTRACTS=true ;;
  esac
done

# ─── Chain / RPC defaults ─────────────────────────────────────────────────────
EVM_RPC="${INITIA_EVM_RPC:-http://localhost:8545}"
TENDERMINT_RPC="${INITIA_RPC_URL:-http://localhost:26657}"

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────
log "Checking prerequisites..."

need() {
  command -v "$1" >/dev/null 2>&1 || err "'$1' not found. $2"
}

need node   "Install Node.js 20+ from https://nodejs.org"
need pnpm   "Run: npm install -g pnpm"
need forge  "Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
need cast   "Part of Foundry — run foundryup"
need jq     "Install jq: brew install jq  (macOS) or apt install jq"

NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
(( NODE_MAJOR >= 20 )) || err "Node.js 20+ required (found $(node --version))"

if [[ "$SKIP_CHAIN" == false ]]; then
  need weave "Install weave: see https://docs.initia.xyz or run the Initia setup wizard"
fi

ok "All prerequisites present"

# ─── 2. Install dependencies ──────────────────────────────────────────────────
log "Installing pnpm dependencies..."
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ─── 3. Start Initia chain ────────────────────────────────────────────────────
if [[ "$SKIP_CHAIN" == false ]]; then
  if curl -sf "$TENDERMINT_RPC/status" >/dev/null 2>&1; then
    ok "Chain already running at $TENDERMINT_RPC"
  else
    log "Starting Initia pillow-rollup chain (weave rollup start -d)..."
    weave rollup start -d || warn "weave start returned non-zero (chain may already be running)"

    log "Waiting for chain to be healthy..."
    ATTEMPTS=0
    until curl -sf "$TENDERMINT_RPC/status" >/dev/null 2>&1; do
      (( ATTEMPTS++ ))
      if (( ATTEMPTS >= 60 )); then
        err "Chain did not become healthy after 120 s. Check: weave rollup log -n 50"
      fi
      printf "  waiting %d/60...\r" "$ATTEMPTS"
      sleep 2
    done
    echo ""
    ok "Chain is up at $TENDERMINT_RPC"
  fi
else
  if ! curl -sf "$TENDERMINT_RPC/status" >/dev/null 2>&1; then
    err "Chain not reachable at $TENDERMINT_RPC and --skip-chain was set. Start it first."
  fi
  ok "Chain reachable at $TENDERMINT_RPC (skipped start)"
fi

# ─── 4. Resolve deployer private key ─────────────────────────────────────────
resolve_private_key() {
  # Priority: shell env → root .env PRIVATE_KEY → derive from INITIATE_MNEMONIC → weave gas-station
  if [[ -n "${PRIVATE_KEY:-}" ]]; then
    echo "$PRIVATE_KEY"; return
  fi

  if [[ -f "$REPO_ROOT/.env" ]]; then
    local pk; pk=$(grep -E '^PRIVATE_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    if [[ -n "$pk" ]]; then echo "$pk"; return; fi

    local mnemonic; mnemonic=$(grep -E '^INITIATE_MNEMONIC=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    if [[ -n "$mnemonic" ]]; then
      local derived; derived=$(cast wallet private-key --mnemonic "$mnemonic" 2>/dev/null || true)
      if [[ -n "$derived" ]]; then echo "$derived"; return; fi
    fi
  fi

  if [[ -f ~/.weave/config.json ]]; then
    local mnemonic; mnemonic=$(jq -r '.common.gas_station.mnemonic // empty' ~/.weave/config.json 2>/dev/null || true)
    if [[ -n "$mnemonic" ]]; then
      local derived; derived=$(cast wallet private-key --mnemonic "$mnemonic" 2>/dev/null || true)
      if [[ -n "$derived" ]]; then echo "$derived"; return; fi
    fi
  fi

  echo ""
}

if [[ "$SKIP_CONTRACTS" == false ]]; then
  PRIVATE_KEY=$(resolve_private_key)

  if [[ -z "$PRIVATE_KEY" ]]; then
    echo ""
    warn "No deployer key found automatically."
    echo "    Options:"
    echo "    a) Set PRIVATE_KEY=0x... in root .env"
    echo "    b) Set INITIATE_MNEMONIC=\"word1 word2 ...\" in root .env"
    echo "    c) Enter it now:"
    read -rsp "  Private key (0x...): " PRIVATE_KEY
    echo ""
    [[ -z "$PRIVATE_KEY" ]] && err "Private key required for contract deployment."
  fi

  # Ensure 0x prefix
  [[ "$PRIVATE_KEY" != 0x* ]] && PRIVATE_KEY="0x${PRIVATE_KEY}"

  DEPLOYER_ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY")
  ok "Deployer: $DEPLOYER_ADDRESS"

  # Sanity check — account must have GAS for deployment
  BALANCE=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$EVM_RPC" 2>/dev/null || echo "0")
  if [[ "$BALANCE" == "0" ]]; then
    warn "Deployer balance is 0. Transactions may fail."
    warn "Fund it: minitiad tx bank send <funded-key> $DEPLOYER_ADDRESS 100000000000000000000GAS --keyring-backend test --chain-id pillow-rollup --node $TENDERMINT_RPC -y"
    read -rp "  Continue anyway? [y/N]: " cont
    [[ "${cont,,}" != "y" ]] && exit 1
  fi
fi

# ─── 5. Deploy contracts ──────────────────────────────────────────────────────
if [[ "$SKIP_CONTRACTS" == false ]]; then
  log "Deploying contracts to $EVM_RPC..."
  cd "$REPO_ROOT/contracts"

  # 5a. Agent.sol
  log "  Deploying Agent.sol..."
  AGENT_OUT=$(PRIVATE_KEY="$PRIVATE_KEY" forge script script/DeployAgent.s.sol:DeployAgent \
    --rpc-url "$EVM_RPC" --broadcast --slow 2>&1 | tee /dev/stderr)
  AGENT_ADDRESS=$(echo "$AGENT_OUT" | grep -oE "Agent deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  [[ -z "$AGENT_ADDRESS" ]] && err "Failed to parse Agent address from deploy output."
  ok "  Agent:       $AGENT_ADDRESS"

  # 5b. iUSD Demo Token + Faucet
  log "  Deploying IUSDDemoToken + IUSDDemoFaucet..."
  IUSD_OUT=$(PRIVATE_KEY="$PRIVATE_KEY" forge script script/DeployIUSDDemo.s.sol:DeployIUSDDemo \
    --rpc-url "$EVM_RPC" --broadcast --slow 2>&1 | tee /dev/stderr)
  IUSD_TOKEN=$(echo "$IUSD_OUT" | grep -oE "iUSD-demo token deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  IUSD_FAUCET=$(echo "$IUSD_OUT" | grep -oE "iUSD-demo faucet deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  [[ -z "$IUSD_TOKEN" ]]  && err "Failed to parse iUSD token address."
  [[ -z "$IUSD_FAUCET" ]] && err "Failed to parse iUSD faucet address."
  ok "  iUSD Token:  $IUSD_TOKEN"
  ok "  iUSD Faucet: $IUSD_FAUCET"

  # 5c. MockPerpDEX (reuses the iUSD token we just deployed)
  log "  Deploying MockPerpDEX..."
  PERP_OUT=$(PRIVATE_KEY="$PRIVATE_KEY" IUSD_TOKEN_ADDRESS="$IUSD_TOKEN" \
    forge script script/DeployMockPerpDEX.s.sol:DeployMockPerpDEX \
    --rpc-url "$EVM_RPC" --broadcast --slow 2>&1 | tee /dev/stderr)
  PERP_DEX=$(echo "$PERP_OUT" | grep -oE "MockPerpDEX deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  [[ -z "$PERP_DEX" ]] && err "Failed to parse MockPerpDEX address."
  ok "  MockPerpDEX: $PERP_DEX"

  cd "$REPO_ROOT"

  # ─── 5d. Write apps/web/.env ──────────────────────────────────────────────
  log "Writing apps/web/.env..."
  REOWN_ID=$(grep -E '^REOWN_PROJECT_ID=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "0d1af33ea5d0930355178d3d8c820785")

  cat > "$REPO_ROOT/apps/web/.env" <<EOF
REOWN_PROJECT_ID=${REOWN_ID}
PLAYWRIGHT_SECRET=playwright-dev-secret

NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=${AGENT_ADDRESS}

NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=${IUSD_TOKEN}
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=${IUSD_FAUCET}

NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=${PERP_DEX}

# Executor = deployer address for local dev (authorise it inside Agent.sol via the UI)
NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS=${DEPLOYER_ADDRESS}

# Showcase target = MockPerpDEX for local dev
NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS=${PERP_DEX}

NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI=1000000000000000000
NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI=5000000000000000000
EOF
  ok "apps/web/.env written"
else
  ok "Skipped contract deployment (using addresses already in apps/web/.env)"
fi

# ─── 6. Write API dev secrets ─────────────────────────────────────────────────
# wrangler dev reads .dev.vars for secrets in local mode
log "Writing apps/api/.dev.vars..."

OR_KEY=$(grep -E '^OPENROUTER_API_KEY=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || echo "")
if [[ -z "$OR_KEY" ]]; then
  echo ""
  warn "OPENROUTER_API_KEY not found in root .env."
  echo "  Get one free at: https://openrouter.ai → Dashboard → API Keys"
  read -rsp "  Paste key (or press Enter to skip — agents won't work without it): " OR_KEY
  echo ""
fi

cat > "$REPO_ROOT/apps/api/.dev.vars" <<EOF
OPENROUTER_API_KEY=${OR_KEY}
PLAYWRIGHT_SECRET=playwright-dev-secret
EOF
ok "apps/api/.dev.vars written"

# ─── 7. Apply local D1 migrations ────────────────────────────────────────────
log "Applying local D1 migrations..."
cd "$REPO_ROOT/apps/api"
pnpm migration:apply:local --yes 2>/dev/null || \
  npx wrangler d1 migrations apply trading-agents --local --yes
ok "D1 migrations applied"
cd "$REPO_ROOT"

# ─── 8. Start services ────────────────────────────────────────────────────────
API_PID=""
WEB_PID=""

cleanup() {
  echo ""
  log "Shutting down..."
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  ok "Done."
}
trap cleanup EXIT INT TERM

log "Starting API on port 8787..."
pnpm dev:api > "$REPO_ROOT/.api.log" 2>&1 &
API_PID=$!

log "Waiting for API to be ready..."
for i in {1..30}; do
  if curl -sf http://localhost:8787/api/health >/dev/null 2>&1; then
    ok "API ready at http://localhost:8787"
    break
  fi
  sleep 2
done

log "Starting Web on port 3001..."
pnpm dev:web > "$REPO_ROOT/.web.log" 2>&1 &
WEB_PID=$!

sleep 4  # Give Nuxt time to start

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Services running:${NC}"
echo -e "  Web  → ${BLUE}http://localhost:3001${NC}"
echo -e "  API  → ${BLUE}http://localhost:8787${NC}"
echo -e "  Chain EVM RPC → ${BLUE}${EVM_RPC}${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Logs: tail -f .api.log  /  tail -f .web.log"
echo "  Press Ctrl+C to stop all services."
echo ""

wait

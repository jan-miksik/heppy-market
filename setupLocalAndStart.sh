#!/usr/bin/env bash
# setupLocalAndStart.sh — One-shot local setup for initRoot
#
# What it does:
#   1. Checks prerequisites
#   2. Installs pnpm dependencies
#   3. Starts the Initia pillow-rollup EVM chain (via weave)
#   4. Deploys all contracts (Agent, iUSD demo, MockPerpDEX)
#   5. Writes apps/web/.env and apps/api/.dev.vars
#   6. Applies local Cloudflare D1 migrations
#   7. Starts the API (port 8787) and Web (port 3001)
#
# Flags:
#   --skip-chain      Skip starting the chain (if already running)
#   --skip-contracts  Skip contract deployment (use addresses already in apps/web/.env)
#
# Usage:
#   chmod +x setupLocalAndStart.sh
#   ./setupLocalAndStart.sh
#   ./setupLocalAndStart.sh --skip-chain
#   ./setupLocalAndStart.sh --skip-chain --skip-contracts

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[•]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

write_atomic() {
  local target="$1"
  local dir tmp
  dir="$(dirname "$target")"
  tmp="$(mktemp "$dir/.tmp.$(basename "$target").XXXXXX")"
  cat > "$tmp"
  mv "$tmp" "$target"
}

has_tty() {
  [[ -t 0 && -t 1 ]]
}

prompt_secret() {
  local __var_name="$1"
  local prompt="$2"
  local value=""

  if has_tty; then
    read -rsp "$prompt" value || true
    echo ""
  fi

  printf -v "$__var_name" '%s' "$value"
}

prompt_line() {
  local __var_name="$1"
  local prompt="$2"
  local value=""

  if has_tty; then
    read -rp "$prompt" value || true
  fi

  printf -v "$__var_name" '%s' "$value"
}

run_and_capture() {
  local __var_name="$1"
  shift

  local tmp status output
  tmp="$(mktemp "${TMPDIR:-/tmp}/setup-local.XXXXXX")"

  set +e
  "$@" 2>&1 | tee "$tmp" >&2
  status=${PIPESTATUS[0]}
  set -e

  output="$(cat "$tmp")"
  rm -f "$tmp"

  printf -v "$__var_name" '%s' "$output"
  return "$status"
}

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════╗"
echo "║ initRoot — prepare local setup           ║"
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
pnpm install --no-frozen-lockfile
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
      ATTEMPTS=$((ATTEMPTS + 1))
      if (( ATTEMPTS >= 60 )); then
        echo ""
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
resolve_private_key_from_env() {
  # Priority: shell env PRIVATE_KEY → shell env INITIATE_MNEMONIC
  if [[ -n "${PRIVATE_KEY:-}" ]]; then
    echo "$PRIVATE_KEY"; return
  fi

  if [[ -n "${INITIATE_MNEMONIC:-}" ]]; then
    local derived; derived=$(cast wallet private-key --mnemonic "$INITIATE_MNEMONIC" 2>/dev/null || true)
    if [[ -n "$derived" ]]; then echo "$derived"; return; fi
  fi

  echo ""
}

resolve_private_key_from_weave() {
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
  PRIVATE_KEY=$(resolve_private_key_from_env)

  if [[ -z "$PRIVATE_KEY" ]]; then
    WEAVE_PRIVATE_KEY=$(resolve_private_key_from_weave)
    if [[ -n "$WEAVE_PRIVATE_KEY" ]]; then
      if has_tty; then
        echo ""
        warn "No deployer key found in shell env."
        prompt_line USE_WEAVE_KEY "  Found a deployer key in ~/.weave/config.json. Use it? [Y/n]: "
        if [[ ! "${USE_WEAVE_KEY,,}" =~ ^(n|no)$ ]]; then
          PRIVATE_KEY="$WEAVE_PRIVATE_KEY"
        fi
      else
        PRIVATE_KEY="$WEAVE_PRIVATE_KEY"
      fi
    fi
  fi

  if [[ -z "$PRIVATE_KEY" ]]; then
    echo ""
    warn "No deployer key found automatically."
    echo "    Options:"
    echo "    a) Export PRIVATE_KEY=0x... in your shell before running this script"
    echo "    b) Export INITIATE_MNEMONIC=\"word1 word2 ...\" in your shell"
    echo "    c) Let the script prompt you now"
    if has_tty; then
      prompt_line INPUT_MODE "  Type 'm' for mnemonic or 'p' for private key [m/p]: "
      if [[ "${INPUT_MODE,,}" == "m" ]]; then
        prompt_secret INPUT_MNEMONIC "  Mnemonic: "
        if [[ -n "$INPUT_MNEMONIC" ]]; then
          PRIVATE_KEY=$(cast wallet private-key --mnemonic "$INPUT_MNEMONIC" 2>/dev/null || true)
        fi
      fi
      if [[ -z "$PRIVATE_KEY" ]]; then
        prompt_secret PRIVATE_KEY "  Private key (0x...): "
      fi
    fi
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
    prompt_line cont "  Continue anyway? [y/N]: "
    [[ "${cont,,}" != "y" ]] && exit 1
  fi
fi

# ─── 5. Deploy contracts ──────────────────────────────────────────────────────
if [[ "$SKIP_CONTRACTS" == false ]]; then
  log "Deploying contracts to $EVM_RPC..."
  cd "$REPO_ROOT/contracts"

  # 5a. Agent.sol
  log "  Deploying Agent.sol..."
  AGENT_STATUS=0
  run_and_capture AGENT_OUT env PRIVATE_KEY="$PRIVATE_KEY" forge script script/DeployAgent.s.sol:DeployAgent \
    --rpc-url "$EVM_RPC" --broadcast --slow || AGENT_STATUS=$?
  AGENT_ADDRESS=$(echo "$AGENT_OUT" | grep -oE "Agent deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  (( AGENT_STATUS == 0 )) || err "Agent deployment failed."
  [[ -z "$AGENT_ADDRESS" ]] && err "Failed to parse Agent address from deploy output."
  ok "  Agent:       $AGENT_ADDRESS"

  # 5b. iUSD Demo Token + Faucet
  log "  Deploying IUSDDemoToken + IUSDDemoFaucet..."
  IUSD_STATUS=0
  run_and_capture IUSD_OUT env PRIVATE_KEY="$PRIVATE_KEY" forge script script/DeployIUSDDemo.s.sol:DeployIUSDDemo \
    --rpc-url "$EVM_RPC" --broadcast --slow || IUSD_STATUS=$?
  IUSD_TOKEN=$(echo "$IUSD_OUT" | grep -oE "iUSD-demo token deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  IUSD_FAUCET=$(echo "$IUSD_OUT" | grep -oE "iUSD-demo faucet deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  [[ -z "$IUSD_TOKEN" ]]  && err "Failed to parse iUSD token address."
  [[ -z "$IUSD_FAUCET" ]] && err "Failed to parse iUSD faucet address."
  if (( IUSD_STATUS != 0 )); then
    warn "DeployIUSDDemo reported a non-zero exit after deploying token/faucet."
    FAUCET_MINTER=$(cast call "$IUSD_TOKEN" 'minters(address)(bool)' "$IUSD_FAUCET" --rpc-url "$EVM_RPC" 2>/dev/null || echo "unknown")
    if [[ "$FAUCET_MINTER" != "true" ]]; then
      warn "Faucet is not an authorized minter on the deployed token. The showcase faucet may not work until fixed manually."
    fi
  fi
  ok "  iUSD Token:  $IUSD_TOKEN"
  ok "  iUSD Faucet: $IUSD_FAUCET"

  # 5c. MockPerpDEX (reuses the iUSD token we just deployed)
  log "  Deploying MockPerpDEX..."
  PERP_STATUS=0
  run_and_capture PERP_OUT env PRIVATE_KEY="$PRIVATE_KEY" IUSD_TOKEN_ADDRESS="$IUSD_TOKEN" \
    forge script script/DeployMockPerpDEX.s.sol:DeployMockPerpDEX \
    --rpc-url "$EVM_RPC" --broadcast --slow || PERP_STATUS=$?
  PERP_DEX=$(echo "$PERP_OUT" | grep -oE "MockPerpDEX deployed at: 0x[0-9a-fA-F]+" | grep -oE "0x[0-9a-fA-F]+" || true)
  if (( PERP_STATUS != 0 )); then
    warn "DeployMockPerpDEX reported a non-zero exit."
  fi
  if [[ -n "$PERP_DEX" ]]; then
    ok "  MockPerpDEX: $PERP_DEX"
  else
    warn "MockPerpDEX address could not be parsed. apps/web/.env will keep MockPerpDEX values empty."
  fi

  cd "$REPO_ROOT"

  # ─── 5d. Write apps/web/.env ──────────────────────────────────────────────
  log "Writing apps/web/.env..."
  write_atomic "$REPO_ROOT/apps/web/.env" <<EOF


NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=${AGENT_ADDRESS}

NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=${IUSD_TOKEN}
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=${IUSD_FAUCET}

NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=${PERP_DEX:-}

# Executor = deployer address for local dev (authorise it inside Agent.sol via the UI)
NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS=${DEPLOYER_ADDRESS}

# Showcase target = MockPerpDEX for local dev
NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS=${PERP_DEX:-}

NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI=1000000000000000000
NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI=5000000000000000000
EOF
  ok "apps/web/.env written"
else
  if [[ ! -s "$REPO_ROOT/apps/web/.env" ]]; then
    err "--skip-contracts was set, but apps/web/.env is missing or empty."
  fi
  ok "Skipped contract deployment (using addresses already in apps/web/.env)"
fi

# ─── 6. Write API dev secrets ─────────────────────────────────────────────────
# wrangler dev reads .dev.vars for secrets in local mode
log "Writing apps/api/.dev.vars..."

# If contracts were skipped, read addresses from the already-written apps/web/.env
if [[ "$SKIP_CONTRACTS" == true ]]; then
  AGENT_ADDRESS=$(grep -E '^NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=' "$REPO_ROOT/apps/web/.env" 2>/dev/null | cut -d= -f2- | tr -d ' ' || echo "")
  PERP_DEX=$(grep -E '^NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=' "$REPO_ROOT/apps/web/.env" 2>/dev/null | cut -d= -f2- | tr -d ' ' || echo "")
fi

# Resolve executor key if not already set (contracts were skipped)
if [[ -z "${PRIVATE_KEY:-}" ]]; then
  PRIVATE_KEY=$(resolve_private_key_from_env)
  if [[ -z "$PRIVATE_KEY" ]]; then
    PRIVATE_KEY=$(resolve_private_key_from_weave)
  fi
fi

# Resolve chain ID from the running node
CHAIN_ID=$(cast chain-id --rpc-url "$EVM_RPC" 2>/dev/null || echo "")
[[ -z "$CHAIN_ID" ]] && warn "Could not resolve INITIA_EVM_CHAIN_ID — fill it in manually in apps/api/.dev.vars"

# Helper: read a single value from an existing .dev.vars file
read_devvar() { grep -E "^${1}=" "$REPO_ROOT/apps/api/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- || echo ""; }

# OPENROUTER_API_KEY: shell env → existing .dev.vars → prompt
OR_KEY="${OPENROUTER_API_KEY:-$(read_devvar OPENROUTER_API_KEY)}"
OR_KEY="${OR_KEY//$'\r'/}"
OR_KEY="${OR_KEY//$'\n'/}"
OR_KEY_PREFIX_COUNT=$(printf '%s' "$OR_KEY" | grep -o 'sk-or-v1-' | wc -l | tr -d ' ' || true)
if [[ -n "$OR_KEY" && "${OR_KEY_PREFIX_COUNT:-0}" -gt 1 ]]; then
  warn "Existing OPENROUTER_API_KEY looks malformed (multiple key prefixes found). Prompting for a replacement."
  OR_KEY=""
fi
if [[ -z "$OR_KEY" ]]; then
  echo ""
  warn "OPENROUTER_API_KEY not set."
  echo "  Get one at: https://openrouter.ai"
  if [[ -t 0 ]]; then
    read -rp "  Paste key visibly (or press Enter to skip — agents won't work without it): " OR_KEY || true
  else
    warn "No interactive TTY available — leaving OPENROUTER_API_KEY empty"
  fi
  echo ""
fi

# KEY_ENCRYPTION_SECRET: shell env → existing .dev.vars → auto-generate
KEY_ENC_SECRET="${KEY_ENCRYPTION_SECRET:-$(read_devvar KEY_ENCRYPTION_SECRET)}"
if [[ -z "$KEY_ENC_SECRET" ]]; then
  KEY_ENC_SECRET=$(openssl rand -hex 32 2>/dev/null || true)
  warn "Generated random KEY_ENCRYPTION_SECRET — keep apps/api/.dev.vars to reuse encrypted keys across runs"
fi

write_atomic "$REPO_ROOT/apps/api/.dev.vars" <<EOF
OPENROUTER_API_KEY=${OR_KEY}
PLAYWRIGHT_SECRET=playwright-dev-secret
KEY_ENCRYPTION_SECRET=${KEY_ENC_SECRET}
INITIA_EVM_RPC=${EVM_RPC}
INITIA_EVM_CHAIN_ID=${CHAIN_ID}
INITIA_AGENT_CONTRACT_ADDRESS=${AGENT_ADDRESS:-}
MOCK_PERP_DEX_ADDRESS=${PERP_DEX:-}
INITIA_EXECUTOR_PRIVATE_KEY=${PRIVATE_KEY:-}
MAX_AGENTS_PER_USER=${MAX_AGENTS_PER_USER:-5}
MAX_MANAGERS_PER_USER=${MAX_MANAGERS_PER_USER:-1}
DEFAULT_MANAGER_MAX_AGENTS=${DEFAULT_MANAGER_MAX_AGENTS:-2}
EOF
ok "apps/api/.dev.vars written"

# ─── 7. Apply local D1 migrations ────────────────────────────────────────────
log "Applying local D1 migrations..."
cd "$REPO_ROOT/apps/api"
pnpm migration:apply:local || \
  npx wrangler d1 migrations apply trading-agents --local
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
pnpm dev:api > >(sed -u 's/^/[api] /') 2>&1 &
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
pnpm dev:web > >(sed -u 's/^/[web] /') 2>&1 &
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
echo "  Output is streamed here with [api] / [web] prefixes."
echo "  Press Ctrl+C to stop all services."
echo ""

wait

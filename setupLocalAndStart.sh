#!/usr/bin/env bash
# setupLocalAndStart.sh — One-shot local setup for initRoot
#
# What it does:
#   1. Checks prerequisites
#   2. Installs pnpm dependencies
#   3. Starts the Initia EVM appchain (via weave)
#   4. Deploys all contracts (Agent, iUSD demo, MockPerpDEX)
#   5. Writes apps/web/.env and apps/api/.dev.vars
#   6. Applies local Cloudflare D1 migrations
#   7. Starts the API (port 8787) and Web (port 3001)
#
# Flags:
#   --skip-chain      Skip starting the chain (if already running)
#   --skip-contracts  Skip contract deployment (use addresses already in apps/web/.env)
#   --reset-opinit    Force-reset local OPinit bot state before starting the chain
#
# Usage:
#   chmod +x setupLocalAndStart.sh
#   ./setupLocalAndStart.sh
#   ./setupLocalAndStart.sh --skip-chain
#   ./setupLocalAndStart.sh --skip-chain --skip-contracts
#   ./setupLocalAndStart.sh --reset-opinit

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[•]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
HAS_TTY=false

write_atomic() {
  local target="$1"
  local dir tmp
  dir="$(dirname "$target")"
  tmp="$(mktemp "$dir/.tmp.$(basename "$target").XXXXXX")"
  cat > "$tmp"
  mv "$tmp" "$target"
}

is_port_bound() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_next_free_web_port() {
  local port

  for port in 3002 3003 3004 3005; do
    if ! is_port_bound "$port"; then
      echo "$port"
      return 0
    fi
  done

  err "Could not find a free web port in the 3002-3005 range"
}

show_port_listeners() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

list_port_listener_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
}

list_process_groups_for_pids() {
  local current_pgid pid pgid
  current_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"

  for pid in "$@"; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$pgid" && "$pgid" != "$current_pgid" ]]; then
      echo "$pgid"
    fi
  done | sort -u
}

kill_port_listeners() {
  local port="$1"
  local pids=()
  local pgids=()
  local pid
  local pgid

  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(list_port_listener_pids "$port")

  if (( ${#pids[@]} == 0 )); then
    return 0
  fi

  while IFS= read -r pgid; do
    [[ -n "$pgid" ]] && pgids+=("$pgid")
  done < <(list_process_groups_for_pids "${pids[@]}")

  kill "${pids[@]}" 2>/dev/null || true
  for pgid in "${pgids[@]}"; do
    kill -TERM -- "-${pgid}" 2>/dev/null || true
  done
  sleep 1

  if is_port_bound "$port"; then
    kill -9 "${pids[@]}" 2>/dev/null || true
    for pgid in "${pgids[@]}"; do
      kill -KILL -- "-${pgid}" 2>/dev/null || true
    done
    sleep 1
  fi

  if is_port_bound "$port"; then
    warn "Port $port is still occupied after trying to stop listener PID(s): ${pids[*]}"
    show_port_listeners "$port"
    err "Could not clear port $port automatically"
  fi
}

pick_web_port() {
  local preferred_port=3001
  local fallback_port choice

  if ! is_port_bound "$preferred_port"; then
    WEB_PORT="$preferred_port"
    return 0
  fi

  fallback_port="$(find_next_free_web_port)"

  warn "Port ${preferred_port} is already in use:"
  show_port_listeners "$preferred_port"

  if has_tty; then
    echo ""
    echo "  [k] Kill the current process on ${preferred_port} and use ${preferred_port}"
    echo "  [d] Keep it running and use ${fallback_port}"
    prompt_line choice "Choose web port action [d]: "
    choice="${choice:-d}"
    case "${choice,,}" in
      k|kill)
        log "Stopping current process(es) on port ${preferred_port}..."
        kill_port_listeners "$preferred_port"
        ok "Port ${preferred_port} is now free"
        WEB_PORT="$preferred_port"
        return 0
        ;;
      d|diff|different)
        WEB_PORT="$fallback_port"
        return 0
        ;;
      *)
        err "Invalid choice: $choice (expected k or d)"
        ;;
    esac
  fi

  warn "No TTY detected; keeping the existing process on ${preferred_port} and using ${fallback_port} instead"
  WEB_PORT="$fallback_port"
}

has_tty() {
  [[ "$HAS_TTY" == true ]]
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

read_first_json_value() {
  local jq_filter="$1"
  shift

  local file value
  for file in "$@"; do
    [[ -f "$file" ]] || continue
    value="$(jq -r "$jq_filter // empty" "$file" 2>/dev/null || true)"
    if [[ -n "$value" && "$value" != "null" ]]; then
      echo "$value"
      return 0
    fi
  done

  echo ""
}

resolve_rollup_chain_id() {
  local status_chain_id genesis_chain_id configured_chain_id

  if [[ -n "${INITIA_ROLLUP_CHAIN_ID:-}" ]]; then
    echo "$INITIA_ROLLUP_CHAIN_ID"
    return 0
  fi

  configured_chain_id="$(read_first_json_value '.l2_config.chain_id' \
    "$HOME/.minitia/artifacts/config.json" \
    "$HOME/.weave/data/minitia.config.json")"
  if [[ -n "$configured_chain_id" ]]; then
    echo "$configured_chain_id"
    return 0
  fi

  configured_chain_id="$(read_first_json_value '.chain_id' "$HOME/.minitia/config/genesis.json")"
  if [[ -n "$configured_chain_id" ]]; then
    echo "$configured_chain_id"
    return 0
  fi

  status_chain_id="$(curl -sf "$TENDERMINT_RPC/status" 2>/dev/null | jq -r '.result.node_info.network // empty' 2>/dev/null || true)"
  if [[ -n "$status_chain_id" ]]; then
    echo "$status_chain_id"
    return 0
  fi

  genesis_chain_id="$(curl -sf "$TENDERMINT_RPC/genesis" 2>/dev/null | jq -r '.result.genesis.chain_id // empty' 2>/dev/null || true)"
  if [[ -n "$genesis_chain_id" ]]; then
    echo "$genesis_chain_id"
    return 0
  fi

  echo ""
}

resolve_evm_chain_id() {
  local raw_chain_id

  if [[ -n "${INITIA_EVM_CHAIN_ID:-}" ]]; then
    echo "$INITIA_EVM_CHAIN_ID"
    return 0
  fi

  raw_chain_id="$(cast chain-id --rpc-url "$EVM_RPC" 2>/dev/null || true)"
  if [[ -n "$raw_chain_id" ]]; then
    echo "$raw_chain_id"
    return 0
  fi

  raw_chain_id="$(
    curl -sf -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "$EVM_RPC" 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true
  )"
  if [[ "$raw_chain_id" =~ ^0x[0-9a-fA-F]+$ ]]; then
    printf '%d\n' "$((16#${raw_chain_id#0x}))"
    return 0
  fi

  echo ""
}

display_rollup_name() {
  local chain_id="${1:-${ROLLUP_CHAIN_ID:-}}"

  if [[ -n "$chain_id" ]]; then
    printf '%s' "$chain_id"
    return 0
  fi

  printf '%s' "rollup"
}

opinit_bot_exists() {
  local bot="$1"

  [[ -f "$HOME/.opinit/${bot}.json" ]] && return 0
  [[ -f "$HOME/.weave/log/opinitd.${bot}.stdout.log" ]] && return 0
  [[ -f "$HOME/.weave/log/opinitd.${bot}.stderr.log" ]] && return 0
  return 1
}

reset_opinit_bot() {
  local bot="$1"

  if ! opinit_bot_exists "$bot"; then
    log "Skipping OPinit $bot reset (no local state found)"
    return
  fi

  log "Resetting OPinit $bot state..."
  weave opinit stop "$bot" >/dev/null 2>&1 || true
  weave opinit reset "$bot"
  RESET_OPINIT_BOTS+=("$bot")
  ok "OPinit $bot state reset"
}

restart_reset_opinit_bots() {
  local bot

  if (( ${#RESET_OPINIT_BOTS[@]} == 0 )); then
    return
  fi

  for bot in "${RESET_OPINIT_BOTS[@]}"; do
    log "Starting OPinit $bot..."
    weave opinit start "$bot" -d
    ok "OPinit $bot restarted"
  done
}

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════╗"
echo "║ initRoot — prepare local setup           ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

if [[ -t 0 && -t 1 ]]; then
  HAS_TTY=true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_CHAIN=false
SKIP_CONTRACTS=false
RESET_OPINIT=false
RESET_OPINIT_BOTS=()
CHAIN_WAS_RUNNING=false

for arg in "$@"; do
  case $arg in
    --skip-chain)     SKIP_CHAIN=true ;;
    --skip-contracts) SKIP_CONTRACTS=true ;;
    --reset-opinit)   RESET_OPINIT=true ;;
    *) err "Unknown flag: $arg" ;;
  esac
done

# ─── Chain / RPC defaults ─────────────────────────────────────────────────────
EVM_RPC="${INITIA_EVM_RPC:-http://localhost:8545}"
TENDERMINT_RPC="${INITIA_RPC_URL:-http://localhost:26657}"
ROLLUP_CHAIN_ID=""
CHAIN_ID=""

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
    CHAIN_WAS_RUNNING=true
  fi

  if [[ "$RESET_OPINIT" == true ]]; then
    reset_opinit_bot executor
    reset_opinit_bot challenger
  fi

  if [[ "$CHAIN_WAS_RUNNING" == true ]]; then
    ok "Chain already running at $TENDERMINT_RPC"
  else
    if [[ "$RESET_OPINIT" == false ]]; then
      log "Chain is down; resetting local OPinit state before boot to avoid stale sequence/signature retries..."
      reset_opinit_bot executor
      reset_opinit_bot challenger
    fi

    log "Starting Initia $(display_rollup_name) chain (weave rollup start -d)..."
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

ROLLUP_CHAIN_ID="$(resolve_rollup_chain_id)"
[[ -z "$ROLLUP_CHAIN_ID" ]] && warn "Could not resolve rollup chain id from local machine config or $TENDERMINT_RPC — preserving existing web config if present"

CHAIN_ID="$(resolve_evm_chain_id)"
[[ -z "$CHAIN_ID" ]] && warn "Could not resolve INITIA_EVM_CHAIN_ID from $EVM_RPC — preserving existing web config if present and fill apps/api/.dev.vars manually if needed"

if [[ "$RESET_OPINIT" == true ]]; then
  restart_reset_opinit_bots
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
    warn "Fund it: minitiad tx bank send <funded-key> $DEPLOYER_ADDRESS 100000000000000000000GAS --keyring-backend test --chain-id $(display_rollup_name) --node $TENDERMINT_RPC -y"
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
  FAUCET_MINTER=$(cast call "$IUSD_TOKEN" 'minters(address)(bool)' "$IUSD_FAUCET" --rpc-url "$EVM_RPC" 2>/dev/null || echo "unknown")
  if (( IUSD_STATUS != 0 )); then
    warn "DeployIUSDDemo reported a non-zero exit after deploying token/faucet."
  fi
  if [[ "$FAUCET_MINTER" != "true" ]]; then
    warn "Faucet is not an authorized minter on the deployed token. Attempting to repair setMinter..."
    cast send "$IUSD_TOKEN" 'setMinter(address,bool)' "$IUSD_FAUCET" true \
      --private-key "$PRIVATE_KEY" --rpc-url "$EVM_RPC" >/dev/null || err "Failed to repair faucet minter authorization."
    FAUCET_MINTER=$(cast call "$IUSD_TOKEN" 'minters(address)(bool)' "$IUSD_FAUCET" --rpc-url "$EVM_RPC" 2>/dev/null || echo "unknown")
    [[ "$FAUCET_MINTER" == "true" ]] || err "Faucet repair did not stick; refusing to continue with a broken faucet deployment."
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
else
  if [[ ! -s "$REPO_ROOT/apps/web/.env" ]]; then
    err "--skip-contracts was set, but apps/web/.env is missing or empty."
  fi
  ok "Skipped contract deployment (using addresses already in apps/web/.env)"
fi

# ─── 5d. Write apps/web/.env ────────────────────────────────────────────────
WEB_ENV_FILE="$REPO_ROOT/apps/web/.env"
read_webenv() {
  grep -E "^${1}=" "$WEB_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || echo ""
}

AGENT_ADDRESS="${AGENT_ADDRESS:-$(read_webenv NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS)}"
IUSD_TOKEN="${IUSD_TOKEN:-$(read_webenv NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS)}"
IUSD_FAUCET="${IUSD_FAUCET:-$(read_webenv NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS)}"
PERP_DEX="${PERP_DEX:-$(read_webenv NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS)}"
DEPLOYER_ADDRESS="${DEPLOYER_ADDRESS:-$(read_webenv NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS)}"
ROLLUP_CHAIN_ID="${ROLLUP_CHAIN_ID:-$(read_webenv NUXT_PUBLIC_INITIA_ROLLUP_CHAIN_ID)}"
CHAIN_ID="${CHAIN_ID:-$(read_webenv NUXT_PUBLIC_INITIA_EVM_CHAIN_ID)}"

WEB_ENV_CONTENT=$(cat <<EOF
NUXT_PUBLIC_INITIA_ROLLUP_CHAIN_ID=${ROLLUP_CHAIN_ID}
NUXT_PUBLIC_INITIA_EVM_CHAIN_ID=${CHAIN_ID}
NUXT_PUBLIC_INITIA_EVM_RPC=${EVM_RPC}
NUXT_PUBLIC_INITIA_RPC_URL=${TENDERMINT_RPC}

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
)
if [[ -f "$WEB_ENV_FILE" ]] && [[ "$(cat "$WEB_ENV_FILE")" == "$WEB_ENV_CONTENT" ]]; then
  ok "apps/web/.env unchanged (skipping write to avoid Vite reload)"
else
  log "Writing apps/web/.env..."
  printf '%s\n' "$WEB_ENV_CONTENT" | write_atomic "$WEB_ENV_FILE"
  ok "apps/web/.env written"
fi

# ─── 6. Write API dev secrets ─────────────────────────────────────────────────
# wrangler dev reads .dev.vars for secrets in local mode
log "Writing apps/api/.dev.vars..."

# Resolve executor key if not already set (contracts were skipped)
if [[ -z "${PRIVATE_KEY:-}" ]]; then
  PRIVATE_KEY=$(resolve_private_key_from_env)
  if [[ -z "$PRIVATE_KEY" ]]; then
    PRIVATE_KEY=$(resolve_private_key_from_weave)
  fi
fi

# Helper: read a single value from an existing .dev.vars file
read_devvar() { grep -E "^${1}=" "$REPO_ROOT/apps/api/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- || echo ""; }
CHAIN_ID="${CHAIN_ID:-$(read_devvar INITIA_EVM_CHAIN_ID)}"

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
    read -rp "  Paste key and press Enter:" OR_KEY || true
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
WEB_HOST="localhost"
WEB_PORT=""
pick_web_port

cleanup() {
  echo ""
  log "Shutting down..."
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  ok "Done."
}
trap cleanup EXIT INT TERM

# Warm Nuxt/.vite dep cache on first run to prevent cold-start page reloads.
# Vite discovers deps lazily and force-reloads the browser for each round;
# running `nuxt prepare` first pre-generates .nuxt/ so most deps are known upfront.
if [[ ! -d "$REPO_ROOT/apps/web/.nuxt" ]]; then
  log "First run detected — warming Nuxt cache (prevents cold-start page reloads)..."
  cd "$REPO_ROOT/apps/web"
  pnpm exec nuxt prepare 2>&1 | sed -u 's/^/[web-prepare] /' || true
  cd "$REPO_ROOT"
  ok "Nuxt cache warmed"
fi

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

log "Starting Web on ${WEB_HOST}:${WEB_PORT}..."
HOST="$WEB_HOST" PORT="$WEB_PORT" pnpm dev:web > >(sed -u 's/^/[web] /') 2>&1 &
WEB_PID=$!

log "Waiting for Web to be ready..."
for i in {1..30}; do
  if curl -sf "http://${WEB_HOST}:${WEB_PORT}" >/dev/null 2>&1; then
    ok "Web ready at http://${WEB_HOST}:${WEB_PORT}"
    break
  fi
  sleep 2
done

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Services running:${NC}"
echo -e "  Web  → ${BLUE}http://${WEB_HOST}:${WEB_PORT}${NC}"
echo -e "  API  → ${BLUE}http://localhost:8787${NC}"
echo -e "  Chain EVM RPC → ${BLUE}${EVM_RPC}${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Output is streamed here with [api] / [web] prefixes."
echo "  Press Ctrl+C to stop all services."
echo ""

wait

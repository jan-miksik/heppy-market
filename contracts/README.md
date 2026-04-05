## Contracts

This folder now uses a single `Agent.sol` contract as the source of truth.

- `src/Agent.sol` (core implementation)
  - Multiple agents per user (ID-based vaults).
  - `autoSignEnabled` as the master switch for delegated execution.
  - Per-agent delegated executor approvals (`canTick`, `canTrade`, per-trade and daily native limits).
  - Per-agent target whitelist for trade calls.
  - Native + ERC-20 deposit/withdraw per agent.
  - Guarded execution primitives (`executeTick`, `executeTradeCall`, `executeTokenTrade`).

## Build / Test

From `contracts/`:

```bash
forge build
forge test -vv
```

## Scripts

- `script/DeployAgent.s.sol` (deploys `Agent`)

Example:

```bash
forge script script/DeployAgent.s.sol:DeployAgent --rpc-url <RPC_URL> --broadcast
```

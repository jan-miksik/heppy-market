## Contracts

This folder includes the core `Agent.sol` contract plus the demo `iUSD-demo` token/faucet contracts.

- `src/Agent.sol` (core implementation)
  - Multiple agents per user (ID-based vaults).
  - `autoSignEnabled` as the master switch for delegated execution.
  - Per-agent delegated executor approvals (`canTick`, `canTrade`, per-trade and daily native limits).
  - Per-agent target whitelist for trade calls.
  - Native + ERC-20 deposit/withdraw per agent.
  - Guarded execution primitives (`executeTick`, `executeTradeCall`, `executeTokenTrade`).
- `src/IUSDDemoToken.sol` (test token used as `iUSD-demo`)
  - 18 decimals, mintable by authorized minters.
- `src/IUSDDemoFaucet.sol` (test faucet for `iUSD-demo`)
  - Unlimited mint on demand for connected test wallets.

## Build / Test

From `contracts/`:

```bash
forge build
forge test -vv
```

## Scripts

- `script/DeployAgent.s.sol` (deploys `Agent`)
- `script/DeployIUSDDemo.s.sol` (deploys `IUSDDemoToken` + `IUSDDemoFaucet`, and grants faucet minter role)

Example:

```bash
forge script script/DeployAgent.s.sol:DeployAgent --rpc-url <RPC_URL> --broadcast
forge script script/DeployIUSDDemo.s.sol:DeployIUSDDemo --rpc-url <RPC_URL> --broadcast
```

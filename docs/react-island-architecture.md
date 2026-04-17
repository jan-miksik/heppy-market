# React Island Architecture — InterwovenKit in Nuxt

## Overview

initRoot is a Nuxt 4 SPA. InterwovenKit (the Initia wallet connector) is a **React-only library**. To bridge this gap, we embed a hidden React island directly inside the Nuxt app — a lightweight pattern that lets us use React components without rewriting the entire frontend.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Nuxt SPA  (Vue 3)                                       │  │
│  │                                                          │  │
│  │  app.vue / connect.vue / agents/*.vue                    │  │
│  │       │                                                  │  │
│  │  useInitiaBridge()   ←── Vue composable                  │  │
│  │       │  reads: initiaBridgeState (Vue ref)              │  │
│  │       │  writes: CustomEvent → window                    │  │
│  │       │                                                  │  │
│  │  ─────┼──── window CustomEvents + window API ─────────  │  │
│  │       │                                                  │  │
│  │  <div id="initia-bridge-root" style="display:none">     │  │
│  │  │                                                       │  │
│  │  │  React island  (react-bridge.ts)                     │  │
│  │  │                                                       │  │
│  │  │  InterwovenKitProvider                               │  │
│  │  │  └── WagmiProvider                                   │  │
│  │  │      └── QueryClientProvider                         │  │
│  │  │          └── BridgeRuntime                           │  │
│  │  │              useInterwovenKit()                       │  │
│  │  │               initiaAddress, evmAddress              │  │
│  │  │               openConnect(), openWallet()            │  │
│  │  │               requestTxBlock()                       │  │
│  │  └───────────────────────────────────────────────────── │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Communication Protocol

The React island and the Nuxt app communicate through two channels.

### 1. Direct window API (synchronous, low-latency)

Mounted once by the React island. Used for modal triggers.

```
window.__initiaBridgeApi = {
  openConnect()   →  opens InterwovenKit connect modal
  openWallet()    →  opens InterwovenKit wallet panel
  refresh()       →  re-fetches on-chain balances
}
```

Nuxt calls these directly when a "Connect" button is clicked.

### 2. Custom DOM Events (async, reactive)

Used for state updates and long-running transactions.

```
React  →  Nuxt    INITIA_BRIDGE_STATE_EVENT
                  Fires on every state change (address, balance,
                  agentExists, busyAction, etc.)
                  Nuxt composable merges payload into Vue ref.

Nuxt   →  React   INITIA_BRIDGE_ACTION_EVENT
                  Carries { id, action, params }
                  Actions: deposit, withdraw, createAgentOnchain,
                           enableAutoSign, disableAutoSign, executeTick

React  →  Nuxt    INITIA_BRIDGE_RESPONSE_EVENT
                  Carries { id, ok, result, error }
                  Nuxt awaits this by matching the request id.
```

---

## Connect + Auth Flow

```
User clicks "Connect wallet"
        │
        ▼
Nuxt: openInitiaConnect()
  └── calls window.__initiaBridgeApi.openConnect()
             │  (fire-and-forget — modal opens, function returns)
             ▼
      InterwovenKit modal displayed
             │
      User selects and approves wallet
             │
             ▼
React: initiaAddress / evmAddress state updates
  └── useEffect → dispatchBridgeState(newState)
             │
             ▼
Nuxt: INITIA_BRIDGE_STATE_EVENT received
  └── initiaBridgeState ref updated
             │
             ▼
Nuxt: watch(walletConnected) fires in connect.vue
  └── SIWE flow via `useAuth().signIn()`
             │
             ▼
  └── fetchMe() → authUser ref populated
             │
             ▼
  └── navigateTo('/agents')
```

> **Why a watcher instead of awaiting openConnect?**
> `openConnect()` opens the modal UI and returns immediately — it has no way to signal
> when the user finishes connecting. State arrives asynchronously via the bridge state
> event. The watcher pattern decouples button press from auth completion.

---

## Transaction Flow (e.g. deposit)

```
Nuxt: deposit("0.5")
  └── sendBridgeAction({ action: 'deposit', params: { amount: '0.5' } })
        │  dispatches INITIA_BRIDGE_ACTION_EVENT with unique id
        │  awaits INITIA_BRIDGE_RESPONSE_EVENT matching that id
        ▼
React: onAction handler receives event
  └── encodeFunctionData (viem)
  └── requestTxBlock({ chainId, messages: [MsgCall] })
        │  user approves in InterwovenKit
        ▼
  └── dispatchBridgeResponse(id, ok=true, { txHash })
        ▼
Nuxt: Promise resolves with { txHash }
```

---

## Bridge State Shape

Every state dispatch carries the full snapshot:

```ts
interface InitiaBridgeState {
  ready: boolean             // React island has mounted
  chainOk: boolean           // EVM RPC is reachable
  initiaAddress: string|null // bech32  e.g. init1abc...
  evmAddress: string|null    // 0x hex  e.g. 0xabc...
  walletBalanceWei: string|null
  vaultBalanceWei: string    // agent contract balance
  agentExists: boolean
  autoSignEnabled: boolean
  busyAction: string|null    // e.g. 'deposit', 'createAgentOnchain'
  lastTxHash: string|null
  error: string|null
}
```

---

## Key Files

| File | Role |
|------|------|
| `apps/web/utils/initia/react-bridge.ts` | React island: providers, BridgeRuntime, event dispatch |
| `apps/web/utils/initia/bridge-types.ts` | Shared event names + TypeScript types |
| `apps/web/composables/useInitiaBridge.ts` | Vue composable: state ref, action helpers, event listeners |
| `apps/web/composables/useInterwovenWallet.ts` | EIP-1193 provider access (window.interwoven.ethereum) |
| `apps/web/pages/connect.vue` | Connect page: opens modal, watches bridge state, triggers auth |
| `apps/api/src/routes/auth.ts` | Hackathon session endpoint (no SIWE required) |

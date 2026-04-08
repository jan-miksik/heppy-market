export const INITIA_BRIDGE_ACTION_EVENT = 'initia:bridge:action';
export const INITIA_BRIDGE_RESPONSE_EVENT = 'initia:bridge:response';
export const INITIA_BRIDGE_STATE_EVENT = 'initia:bridge:state';

export type InitiaBridgeActionName =
  | 'openConnect'
  | 'openWallet'
  | 'openBridge'
  | 'refresh'
  | 'createAgentOnchain'
  | 'deposit'
  | 'withdraw'
  | 'mintShowcaseToken'
  | 'depositShowcaseToken'
  | 'withdrawShowcaseToken'
  | 'authorizeExecutor'
  | 'enableAutoSign'
  | 'disableAutoSign'
  | 'executeTick';

export interface InitiaBridgeActionPayload {
  id: string;
  action: InitiaBridgeActionName;
  params?: Record<string, unknown>;
}

export interface InitiaBridgeActionEventDetail {
  type: 'action';
  payload: InitiaBridgeActionPayload;
}

export interface InitiaBridgeResponsePayload {
  id: string;
  ok: boolean;
  result?: Record<string, unknown> | null;
  error?: string;
}

export interface InitiaBridgeResponseEventDetail {
  type: 'response';
  payload: InitiaBridgeResponsePayload;
}

export interface InitiaBridgeState {
  ready: boolean;
  chainOk: boolean;
  initiaAddress: string | null;
  evmAddress: string | null;
  onchainAgentId: string | null;
  walletBalanceWei: string | null;
  vaultBalanceWei: string | null;
  walletShowcaseTokenBalanceWei: string | null;
  showcaseTokenBalanceWei: string | null;
  agentExists: boolean;
  executorAuthorized: boolean;
  autoSignEnabled: boolean;
  busyAction: string | null;
  lastTxHash: string | null;
  error: string | null;
}

export interface InitiaBridgeStateEventDetail {
  type: 'state';
  payload: InitiaBridgeState;
}

export interface InitiaBridgeOpenParams {
  [key: string]: unknown;
  srcChainId?: string;
  srcDenom?: string;
  quantity?: string;
}

export type InitiaBridgeAction =
  | { action: 'openConnect' }
  | { action: 'openWallet' }
  | { action: 'openBridge'; params?: InitiaBridgeOpenParams }
  | { action: 'refresh' }
  | { action: 'createAgentOnchain'; params: { metadataPointer: Record<string, unknown>; autoSign?: boolean } }
  | { action: 'deposit'; params: { amount: string; autoSign?: boolean } }
  | { action: 'withdraw'; params: { amount: string; autoSign?: boolean } }
  | { action: 'mintShowcaseToken'; params: { amount: string; autoSign?: boolean } }
  | { action: 'depositShowcaseToken'; params: { amount: string; autoSign?: boolean } }
  | { action: 'withdrawShowcaseToken'; params: { amount: string; autoSign?: boolean } }
  | { action: 'authorizeExecutor'; params?: { autoSign?: boolean } }
  | { action: 'enableAutoSign' }
  | { action: 'disableAutoSign' }
  | { action: 'executeTick'; params?: { autoSign?: boolean } };

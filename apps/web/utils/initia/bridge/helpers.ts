import type {
  InitiaBridgeResponseEventDetail,
  InitiaBridgeState,
  InitiaBridgeStateEventDetail,
} from '~/utils/initia/bridge-types';
import {
  INITIA_BRIDGE_RESPONSE_EVENT,
  INITIA_BRIDGE_STATE_EVENT,
} from '~/utils/initia/bridge-types';

export function buildMsgCall(sender: string, contractAddress: string, input: string, value = '0x0') {
  let decimalValue = "0";
  if (value.startsWith('0x')) {
    decimalValue = BigInt(value).toString(10);
  } else {
    decimalValue = BigInt(value || "0").toString(10);
  }
  return {
    typeUrl: '/minievm.evm.v1.MsgCall',
    value: {
      sender: sender.toLowerCase(),
      contractAddr: contractAddress.toLowerCase(),
      input,
      value: decimalValue,
      accessList: [],
      authList: [],
    },
  };
}

export function dispatchBridgeState(payload: InitiaBridgeState) {
  const detail: InitiaBridgeStateEventDetail = { type: 'state', payload };
  window.dispatchEvent(new CustomEvent<InitiaBridgeStateEventDetail>(INITIA_BRIDGE_STATE_EVENT, { detail }));
}

export function dispatchBridgeResponse(id: string, ok: boolean, result?: Record<string, unknown> | null, error?: string) {
  const detail: InitiaBridgeResponseEventDetail = {
    type: 'response',
    payload: { id, ok, result: result ?? null, error },
  };
  window.dispatchEvent(new CustomEvent<InitiaBridgeResponseEventDetail>(INITIA_BRIDGE_RESPONSE_EVENT, { detail }));
}

export function extractTxHash(tx: unknown): string | null {
  const candidate = tx as {
    txhash?: string;
    txHash?: string;
    tx_hash?: string;
    transactionHash?: string;
  } | null;
  return candidate?.txhash ?? candidate?.txHash ?? candidate?.tx_hash ?? candidate?.transactionHash ?? null;
}

export function normalizeInitiaAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function normalizeEvmAddress(raw: string | null | undefined): `0x${string}` | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(value) ? (value as `0x${string}`) : null;
}

export function normalizeEvmOptionAddress(raw: string | null | undefined): `0x${string}` | null {
  return normalizeEvmAddress(raw);
}

export function bech32ToEvmHex(bech32Addr: string | null | undefined): `0x${string}` | null {
  if (!bech32Addr) return null;
  try {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const lower = bech32Addr.toLowerCase();
    const sep = lower.lastIndexOf('1');
    if (sep < 1) return null;
    const dataStr = lower.slice(sep + 1);
    if (dataStr.length < 7) return null;
    const values: number[] = [];
    for (let i = 0; i < dataStr.length - 6; i++) {
      const v = CHARSET.indexOf(dataStr.charAt(i));
      if (v === -1) return null;
      values.push(v);
    }
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const val of values) {
      acc = (acc << 5) | val;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }
    if (bytes.length !== 20) return null;
    return `0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  } catch {
    return null;
  }
}

export function normalizeBridgeParam(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}

export function parseU128(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  try {
    const n = BigInt(raw);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

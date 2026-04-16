import type { users } from '../../db/schema.js';

export const SESSION_TTL_SECS = 60 * 60 * 24 * 7; // 7 days
export const SESSION_HOT_CACHE_TTL_MS = 30_000;
export const SESSION_HOT_CACHE_MAX_ENTRIES = 5_000;
export const NONCE_TTL_SECS = 300; // 5 minutes

export interface SessionData {
  userId: string;
  walletAddress: string;
  expiresAt: number;
}

export interface AuthVariables {
  userId: string;
  walletAddress: string;
}

export interface VerifySiweOptions {
  message: string;
  signature: string;
  db: D1Database;
  cache: KVNamespace;
  baseRpcUrl?: string;
  initiaRpcUrl?: string;
  rpcUrl?: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  avatarUrl?: string;
}

export interface VerifySiweResult {
  user: typeof users.$inferSelect;
  sessionToken: string;
}

export interface ParsedSiwe {
  address: string;
  nonce: string;
  domain: string;
  chainId: number;
  /** ISO-8601 string from the EIP-4361 "Expiration Time:" field, if present */
  expirationTime?: string;
  /** ISO-8601 string from the EIP-4361 "Issued At:" field, if present */
  issuedAt?: string;
}

export type AnyContext = {
  req: { header: (k: string) => string | undefined };
  env: { CACHE: KVNamespace; DB: D1Database };
  set: (k: string, v: unknown) => void;
  json: (body: unknown, status?: number) => Response;
};

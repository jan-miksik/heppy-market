import { createPublicClient, defineChain, http, verifyMessage } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { generateId, nowIso } from '../utils.js';
import { consumeNonce, createSession } from './session-store.js';
import type { ParsedSiwe, VerifySiweOptions, VerifySiweResult } from './types.js';

const ALLOWED_SIWE_DOMAINS = [
  'localhost',
  'localhost:3000',
  'localhost:3001',
  'localhost:3002',
  'localhost:5173',
  'localhost:4173',
  '127.0.0.1',
  '0.0.0.0',
  'something-in-loop.market',
  'something-in-loop.pages.dev',
];

const MAX_SIWE_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function parseSiweMessage(message: string): ParsedSiwe {
  const lines = message.split('\n');
  const address = lines[1]?.trim() ?? '';
  const nonce = (lines.find((l) => l.startsWith('Nonce:')) ?? '').replace('Nonce:', '').trim();
  const chainId = parseInt(
    (lines.find((l) => l.startsWith('Chain ID:')) ?? '').replace('Chain ID:', '').trim() || '0',
    10
  );
  const domain = (lines[0] ?? '').split(' wants you to')[0].trim();
  const expirationTime = (lines.find((l) => l.startsWith('Expiration Time:')) ?? '').replace('Expiration Time:', '').trim() || undefined;
  const issuedAt = (lines.find((l) => l.startsWith('Issued At:')) ?? '').replace('Issued At:', '').trim() || undefined;
  return { address, nonce, domain, chainId, expirationTime, issuedAt };
}

export function isAllowedSiweDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(normalized)) return true;

  return ALLOWED_SIWE_DOMAINS.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`)
  );
}

export async function verifySiweAndCreateSession(opts: VerifySiweOptions): Promise<VerifySiweResult> {
  const { message, signature, db: d1, cache } = opts;

  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) {
    throw new Error('Invalid SIWE message format');
  }

  if (!isAllowedSiweDomain(parsed.domain)) {
    throw new Error(`SIWE domain "${parsed.domain}" is not allowed`);
  }

  const now = Date.now();
  if (parsed.expirationTime) {
    const expiry = new Date(parsed.expirationTime).getTime();
    if (isNaN(expiry) || expiry < now) {
      throw new Error('SIWE message has expired');
    }
  }
  if (parsed.issuedAt) {
    const issued = new Date(parsed.issuedAt).getTime();
    if (isNaN(issued) || now - issued > MAX_SIWE_AGE_MS) {
      throw new Error('SIWE message is too old');
    }
  }

  const nonceValid = await consumeNonce(cache, d1, parsed.nonce);
  if (!nonceValid) throw new Error('Invalid or expired nonce');

  if (!Number.isInteger(parsed.chainId) || parsed.chainId <= 0) {
    throw new Error('Invalid SIWE chain ID');
  }

  const fallbackRpc = opts.rpcUrl;
  let chain: ReturnType<typeof defineChain> | typeof base | typeof baseSepolia;
  let rpcUrl: string;

  if (parsed.chainId === 8453) {
    chain = base;
    rpcUrl = opts.baseRpcUrl ?? fallbackRpc ?? 'https://mainnet.base.org';
  } else if (parsed.chainId === 84532) {
    chain = baseSepolia;
    rpcUrl = opts.baseRpcUrl ?? fallbackRpc ?? 'https://sepolia.base.org';
  } else {
    rpcUrl = opts.initiaRpcUrl ?? fallbackRpc ?? 'http://localhost:8545';
    chain = defineChain({
      id: parsed.chainId,
      name: `EVM Chain ${parsed.chainId}`,
      network: `evm-${parsed.chainId}`,
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    });
  }

  let isValid = false;
  try {
    isValid = await verifyMessage({
      address: parsed.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    // EOA verification failed, try RPC-backed verification next.
  }

  if (!isValid) {
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    try {
      isValid = await publicClient.verifyMessage({
        address: parsed.address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch (err) {
      console.error('[auth] verifyMessage error:', (err as Error)?.message);
      throw new Error('Signature verification failed');
    }
  }
  if (!isValid) throw new Error('Invalid signature');

  const walletAddress = parsed.address.toLowerCase();
  const orm = drizzle(d1);
  const [existing] = await orm.select().from(users).where(eq(users.walletAddress, walletAddress));

  let userId: string;
  if (existing) {
    userId = existing.id;
    const updates: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (opts.email && !existing.email) updates.email = opts.email;
    if (opts.displayName && !existing.displayName) updates.displayName = opts.displayName;
    if (opts.avatarUrl && !existing.avatarUrl) updates.avatarUrl = opts.avatarUrl;
    if (opts.authProvider) updates.authProvider = opts.authProvider;
    await orm.update(users).set(updates).where(eq(users.id, userId));
  } else {
    userId = generateId('user');
    await orm.insert(users).values({
      id: userId,
      walletAddress,
      email: opts.email ?? null,
      displayName: opts.displayName ?? null,
      authProvider: opts.authProvider ?? 'wallet',
      avatarUrl: opts.avatarUrl ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const [user] = await orm.select().from(users).where(eq(users.id, userId));
  const sessionToken = await createSession(cache, userId, walletAddress, d1);
  return { user, sessionToken };
}

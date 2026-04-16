import { decryptKey, encryptKey } from './crypto.js';

type ResolveStoredOpenRouterKeyParams = {
  storedKey: string | null | undefined;
  serverKey: string;
  encryptionSecret: string | undefined;
  logPrefix: string;
  persistEncrypted?: (encryptedKey: string) => Promise<void>;
};

export type ResolvedOpenRouterKey = {
  apiKey: string;
  source: 'server' | 'user-encrypted' | 'user-plaintext-legacy';
};

const LEGACY_PLAINTEXT_OPENROUTER_KEY_RE = /^sk(?:-or-v1)?-[A-Za-z0-9_-]{16,}$/;

function isLikelyLegacyPlaintextOpenRouterKey(value: string): boolean {
  return LEGACY_PLAINTEXT_OPENROUTER_KEY_RE.test(value.trim());
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export async function resolveStoredOpenRouterKey(
  params: ResolveStoredOpenRouterKeyParams,
): Promise<ResolvedOpenRouterKey> {
  const { storedKey, serverKey, encryptionSecret, logPrefix, persistEncrypted } = params;
  const trimmedKey = storedKey?.trim();

  if (!trimmedKey) {
    return { apiKey: serverKey, source: 'server' };
  }

  if (isLikelyLegacyPlaintextOpenRouterKey(trimmedKey)) {
    if (encryptionSecret && persistEncrypted) {
      try {
        const encryptedKey = await encryptKey(trimmedKey, encryptionSecret);
        await persistEncrypted(encryptedKey);
        console.warn(`${logPrefix} user OR key was stored in legacy plaintext format; re-encrypted in place`);
      } catch (error) {
        console.warn(`${logPrefix} failed to re-encrypt legacy plaintext user OR key: ${formatError(error)}`);
      }
    }

    return { apiKey: trimmedKey, source: 'user-plaintext-legacy' };
  }

  if (!encryptionSecret) {
    console.warn(`${logPrefix} user OR key appears encrypted but KEY_ENCRYPTION_SECRET is missing; using server fallback`);
    return { apiKey: serverKey, source: 'server' };
  }

  try {
    const apiKey = await decryptKey(trimmedKey, encryptionSecret);
    return { apiKey, source: 'user-encrypted' };
  } catch (error) {
    console.warn(`${logPrefix} failed to decrypt stored user OR key, using server fallback (${formatError(error)})`);
    return { apiKey: serverKey, source: 'server' };
  }
}

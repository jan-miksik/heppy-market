import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptKey, encryptKey } from '../src/lib/crypto.js';
import { resolveStoredOpenRouterKey } from '../src/lib/openrouter-key.js';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SERVER_KEY = 'sk-or-v1-serverfallbackkey_1234567890';
const USER_KEY = 'sk-or-v1-legacyplaintextkey_1234567890';

describe('resolveStoredOpenRouterKey', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decrypts encrypted user keys', async () => {
    const storedKey = await encryptKey(USER_KEY, SECRET);

    const resolved = await resolveStoredOpenRouterKey({
      storedKey,
      serverKey: SERVER_KEY,
      encryptionSecret: SECRET,
      logPrefix: '[test]',
    });

    expect(resolved).toEqual({
      apiKey: USER_KEY,
      source: 'user-encrypted',
    });
  });

  it('accepts legacy plaintext keys and re-encrypts them in place', async () => {
    const persistEncrypted = vi.fn(async () => {});

    const resolved = await resolveStoredOpenRouterKey({
      storedKey: USER_KEY,
      serverKey: SERVER_KEY,
      encryptionSecret: SECRET,
      logPrefix: '[test]',
      persistEncrypted,
    });

    expect(resolved).toEqual({
      apiKey: USER_KEY,
      source: 'user-plaintext-legacy',
    });
    expect(persistEncrypted).toHaveBeenCalledOnce();

    const reEncryptedValue = persistEncrypted.mock.calls[0][0] as string;
    expect(reEncryptedValue).not.toBe(USER_KEY);
    await expect(decryptKey(reEncryptedValue, SECRET)).resolves.toBe(USER_KEY);
  });

  it('falls back to the server key when encrypted data cannot be decrypted', async () => {
    const storedKey = await encryptKey(USER_KEY, SECRET);

    const resolved = await resolveStoredOpenRouterKey({
      storedKey,
      serverKey: SERVER_KEY,
      encryptionSecret: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      logPrefix: '[test]',
    });

    expect(resolved).toEqual({
      apiKey: SERVER_KEY,
      source: 'server',
    });
  });
});

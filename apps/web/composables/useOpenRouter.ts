/**
 * useOpenRouter — PKCE OAuth flow for connecting a user's OpenRouter account.
 *
 * Flow:
 *  1. initConnect() — generates PKCE verifier+challenge+state, stores verifier
 *                     and state in sessionStorage, redirects to openrouter.ai/auth
 *  2. handleCallback(code, state) — called from /openrouter/callback page, verifies
 *                                   state, sends code+verifier to backend exchange
 *  3. disconnect() — calls DELETE /api/auth/openrouter/disconnect
 */

const VERIFIER_KEY = 'or_pkce_verifier';
const STATE_KEY = 'or_pkce_state';
const RETURN_TO_KEY = 'or_return_to';
const CALLBACK_PATH = '/openrouter/callback';

function normalizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return '/settings';
  const value = raw.trim();
  if (!value.startsWith('/')) return '/settings';
  if (value.startsWith('//')) return '/settings';
  return value;
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const array = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(array.buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(digest);
  return { verifier, challenge };
}

export function useOpenRouter() {
  async function initConnect(opts?: { returnTo?: string }): Promise<void> {
    const { verifier, challenge } = await generatePkce();
    const stateBytes = crypto.getRandomValues(new Uint8Array(16));
    const state = base64url(stateBytes.buffer);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(RETURN_TO_KEY, normalizeReturnTo(opts?.returnTo));

    const callbackUrl = `${window.location.origin}${CALLBACK_PATH}`;
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', callbackUrl);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    window.location.href = url.toString();
  }

  async function handleCallback(code: string, returnedState: string): Promise<string> {
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const returnTo = normalizeReturnTo(sessionStorage.getItem(RETURN_TO_KEY));
    if (!verifier || !expectedState) throw new Error('PKCE session data missing. Please try connecting again.');
    if (returnedState !== expectedState) throw new Error('State mismatch — possible CSRF. Please try connecting again.');
    // Remove before the fetch — intentional. One-time-use secrets must not linger.
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);

    await $fetch('/api/auth/openrouter/exchange', {
      method: 'POST',
      body: { code, code_verifier: verifier, code_challenge_method: 'S256' },
      credentials: 'include',
    });

    return returnTo;
  }

  async function disconnect(): Promise<void> {
    await $fetch('/api/auth/openrouter/disconnect', {
      method: 'DELETE',
      credentials: 'include',
    });
  }

  return { initConnect, handleCallback, disconnect };
}

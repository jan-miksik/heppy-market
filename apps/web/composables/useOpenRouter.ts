/**
 * useOpenRouter — PKCE OAuth flow for connecting a user's OpenRouter account.
 *
 * Flow:
 *  1. initConnect() — generates PKCE verifier+challenge, stores verifier in
 *                     sessionStorage, redirects to openrouter.ai/auth
 *  2. handleCallback(code) — called from /openrouter/callback page, sends
 *                            code+verifier to backend /api/auth/openrouter/exchange
 *  3. disconnect() — calls DELETE /api/auth/openrouter/disconnect
 */

const VERIFIER_KEY = 'or_pkce_verifier';
const CALLBACK_PATH = '/openrouter/callback';

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
  async function initConnect(): Promise<void> {
    const { verifier, challenge } = await generatePkce();
    sessionStorage.setItem(VERIFIER_KEY, verifier);

    const callbackUrl = `${window.location.origin}${CALLBACK_PATH}`;
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', callbackUrl);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    window.location.href = url.toString();
  }

  async function handleCallback(code: string): Promise<void> {
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) throw new Error('PKCE verifier missing from session. Please try connecting again.');
    sessionStorage.removeItem(VERIFIER_KEY);

    await $fetch('/api/auth/openrouter/exchange', {
      method: 'POST',
      body: { code, code_verifier: verifier },
      credentials: 'include',
    });
  }

  async function disconnect(): Promise<void> {
    await $fetch('/api/auth/openrouter/disconnect', {
      method: 'DELETE',
      credentials: 'include',
    });
  }

  return { initConnect, handleCallback, disconnect };
}

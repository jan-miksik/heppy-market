/**
 * useAuth — authentication state + SIWE sign-in/out.
 *
 * Uses Interwoven wallet provider for message signing (SIWE) and hackathon
 * session bootstrap. Safe to call from plugins, middleware, and components alike.
 */
import { ref, computed } from 'vue';
import { createSiweMessage } from 'viem/siwe';
import { navigateTo } from '#app';
import { useInterwovenWallet } from './useInterwovenWallet';

// ─── Module-level auth state ──────────────────────────────────────────────────
// Using module scope (not useState) so the ref is the same instance across
// all calls to useAuth() in a single browser session.

export interface AuthUser {
  id: string;
  walletAddress: string;
  email: string | null;
  displayName: string | null;
  authProvider: string;
  avatarUrl: string | null;
  role: string;
  createdAt: string;
  openRouterKeySet: boolean;
}

const authUser = ref<AuthUser | null>(null);
const authLoading = ref(false);
const authResolved = ref(false);
let fetchMePromise: Promise<void> | null = null;

// ─── Auto-disconnect hook ─────────────────────────────────────────────────────
// Called when Interwoven wallet becomes disconnected.

export async function handleWalletDisconnect(): Promise<boolean> {
  if (!authUser.value) return false; // nothing to sign out of
  // Dev/test sessions have no wallet connection — don't sign them out on disconnect
  if (authUser.value.authProvider === 'playwright') return false;
  authUser.value = null;
  try {
    await $fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Session already gone — that's fine
  }
  return true;
}

// ─── Composable ───────────────────────────────────────────────────────────────

export function useAuth() {
  const wallet = useInterwovenWallet();
  const runtimeConfig = useRuntimeConfig();
  const isAuthenticated = computed(() => !!authUser.value);

  /** Restore session from the HttpOnly session cookie. Deduplicates concurrent calls. */
  function fetchMe(): Promise<void> {
    if (fetchMePromise) return fetchMePromise;
    fetchMePromise = (async () => {
      try {
        const user = await $fetch<AuthUser>('/api/auth/me', {
          credentials: 'include',
          timeout: 8000,
        });
        authUser.value = user;
      } catch (err: unknown) {
        authUser.value = null;
        // 401 is expected when not signed in — don't log it
        const status = (err as { statusCode?: number })?.statusCode
          ?? (err as { status?: number })?.status;
        if (status !== 401) {
          console.error('[auth] fetchMe failed:', err);
        }
      } finally {
        fetchMePromise = null;
        authResolved.value = true;
      }
    })();
    return fetchMePromise;
  }

  /**
   * SIWE sign-in flow:
   *  1. Fetch one-time nonce from backend
   *  2. Build EIP-4361 message
   *  3. Sign with Interwoven wallet provider
   *  4. Verify with backend → session cookie is set in the response
   *
   * Optional: pass profile fields from email/social logins so they're
   * stored in the users table alongside the wallet address.
   */
  async function signIn(opts?: {
    email?: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<void> {
    let addr = wallet.walletAddress.value;
    if (!addr) {
      addr = await wallet.connectWallet();
    }
    if (!addr) throw new Error('No wallet connected');

    authLoading.value = true;
    try {
      // 1. Get a fresh nonce from the backend
      const { nonce } = await $fetch<{ nonce: string }>('/api/auth/nonce');
      const chainId = await wallet.getChainId();
      const fallbackChainId = Number(runtimeConfig.public.initiaEvmChainId || 2178983797612220);

      // 2. Build SIWE message
      const message = createSiweMessage({
        address: addr as `0x${string}`,
        chainId: chainId || fallbackChainId,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to initRoot',
      });

      // 3. Sign with Interwoven provider.
      const signature = await wallet.signPersonalMessage(message, addr);

      // 4. Send to backend; response sets the session cookie
      const user = await $fetch<AuthUser>('/api/auth/verify', {
        method: 'POST',
        body: { message, signature, authProvider: 'interwoven-wallet', ...opts },
        credentials: 'include',
      });

      authUser.value = user;
      authResolved.value = true;
    } finally {
      authLoading.value = false;
    }
  }

  /** Hackathon sign-in flow: create session directly from connected wallet. */
  async function signInHackathon(): Promise<void> {
    let addr = wallet.walletAddress.value;
    if (!addr) {
      addr = await wallet.connectWallet();
    }
    if (!addr) throw new Error('No wallet connected');

    authLoading.value = true;
    try {
      const user = await $fetch<AuthUser>('/api/auth/hackathon-session', {
        method: 'POST',
        body: { walletAddress: addr },
        credentials: 'include',
      });
      authUser.value = user;
      authResolved.value = true;
    } finally {
      authLoading.value = false;
    }
  }

  /** Sign out: invalidate server session + clear local wallet state cache. */
  async function signOut(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Still clear local state even if server call fails
    }
    authUser.value = null;
    wallet.clearWalletState();
    if (import.meta.client) {
      await navigateTo('/connect');
    }
  }

  return {
    user: authUser,
    isAuthenticated,
    isLoading: authLoading,
    authResolved,
    fetchMe,
    signIn,
    signInHackathon,
    signOut,
  };
}

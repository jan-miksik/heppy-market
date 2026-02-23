/**
 * useAuth — authentication state + SIWE sign-in/out.
 *
 * Uses ONLY @wagmi/core actions (signMessage, disconnect) — these call the
 * wagmi config directly and do NOT require Vue's inject() context.
 * Safe to call from plugins, middleware, and components alike.
 *
 * Wallet address / connection state come from module-level refs kept
 * in sync by watchConnection() in the 01.reown.client.ts plugin.
 */
import { ref, computed } from 'vue';
import { signMessage, disconnect } from '@wagmi/core';
import { createSiweMessage } from 'viem/siwe';
import { walletAddress, walletIsConnected } from './useWalletState';
import { getWagmiConfig } from '~/utils/wagmi-config';

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
  createdAt: string;
}

const authUser = ref<AuthUser | null>(null);
const authLoading = ref(false);

// ─── Composable ───────────────────────────────────────────────────────────────

export function useAuth() {
  const isAuthenticated = computed(() => !!authUser.value);

  /** Restore session from the HttpOnly session cookie (called on app start). */
  async function fetchMe(): Promise<void> {
    try {
      const user = await $fetch<AuthUser>('/api/auth/me', { credentials: 'include' });
      authUser.value = user;
    } catch {
      authUser.value = null;
    }
  }

  /**
   * SIWE sign-in flow:
   *  1. Fetch one-time nonce from backend
   *  2. Build EIP-4361 message
   *  3. Sign with wagmi (@wagmi/core — no Vue context needed)
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
    const addr = walletAddress.value;
    if (!addr) throw new Error('No wallet connected');

    authLoading.value = true;
    try {
      // 1. Get a fresh nonce from the backend
      const { nonce } = await $fetch<{ nonce: string }>('/api/auth/nonce');

      // 2. Build SIWE message
      const message = createSiweMessage({
        address: addr as `0x${string}`,
        chainId: 8453, // Base mainnet
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to Heppy Market',
      });

      // 3. Sign with @wagmi/core — no Vue inject() needed
      const signature = await signMessage(getWagmiConfig(), { message });

      // 4. Send to backend; response sets the session cookie
      const user = await $fetch<AuthUser>('/api/auth/verify', {
        method: 'POST',
        body: { message, signature, authProvider: 'wallet', ...opts },
        credentials: 'include',
      });

      authUser.value = user;
    } finally {
      authLoading.value = false;
    }
  }

  /** Sign out: invalidate server session + disconnect wallet. */
  async function signOut(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Still clear local state even if server call fails
    }
    authUser.value = null;
    try {
      await disconnect(getWagmiConfig());
    } catch {
      // Ignore disconnect errors
    }
  }

  return {
    user: authUser,
    isAuthenticated,
    isConnected: walletIsConnected,
    address: walletAddress,
    isLoading: authLoading,
    fetchMe,
    signIn,
    signOut,
  };
}

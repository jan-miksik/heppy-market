/**
 * useAuth — authentication state and SIWE sign-in flow.
 *
 * Flow:
 *  1. User connects wallet (or email/social) via AppKit → address becomes available
 *  2. useAuth.signIn() fetches a nonce, builds SIWE message, signs it, sends to backend
 *  3. Backend verifies signature, upserts user in D1, creates session in KV, sets cookie
 *  4. Session cookie is auto-forwarded by the browser on all subsequent /api/* requests
 */
import { ref, computed } from 'vue';
import { useAppKitAccount, useDisconnect } from '@reown/appkit/vue';
import { useSignMessage } from '@wagmi/vue';
import { createSiweMessage } from 'viem/siwe';

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

export function useAuth() {
  // AppKit account state — address/isConnected are reactive properties on the returned object
  const appKitAccount = useAppKitAccount();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();

  // Handle both Ref<T> and plain reactive object shapes from different AppKit versions
  const address = computed<string>(() => {
    const acc = appKitAccount as any;
    return acc?.value?.address ?? acc?.address ?? '';
  });

  const isConnected = computed<boolean>(() => {
    const acc = appKitAccount as any;
    return acc?.value?.isConnected ?? acc?.isConnected ?? false;
  });

  // Try to get connector info for provider detection
  const connectorId = computed<string>(() => {
    const acc = appKitAccount as any;
    return (
      acc?.value?.embeddedWalletInfo?.authProvider ??
      acc?.embeddedWalletInfo?.authProvider ??
      ''
    );
  });

  const isAuthenticated = computed(() => !!authUser.value);

  /** Fetch current session from backend. Called on app start to restore session. */
  async function fetchMe(): Promise<void> {
    try {
      const user = await $fetch<AuthUser>('/api/auth/me', { credentials: 'include' });
      authUser.value = user;
    } catch {
      authUser.value = null;
    }
  }

  /**
   * Sign in with the currently connected wallet using SIWE.
   * Also accepts optional profile fields from social/email logins.
   */
  async function signIn(opts?: {
    email?: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<void> {
    const addr = address.value;
    if (!addr) throw new Error('No wallet connected');

    authLoading.value = true;
    try {
      // 1. Get one-time nonce from backend
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

      // 3. Sign the message with the connected wallet
      const signature = await signMessageAsync({ message });

      // 4. Detect auth provider (wallet / google / email / etc.)
      const authProvider = connectorId.value
        ? inferProvider(connectorId.value)
        : 'wallet';

      // 5. Verify with backend — response sets the session cookie
      const user = await $fetch<AuthUser>('/api/auth/verify', {
        method: 'POST',
        body: {
          message,
          signature,
          authProvider,
          email: opts?.email,
          displayName: opts?.displayName,
          avatarUrl: opts?.avatarUrl,
        },
        credentials: 'include',
      });

      authUser.value = user;
    } finally {
      authLoading.value = false;
    }
  }

  /** Sign out: invalidate server session + disconnect wallet */
  async function signOut(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Ignore — still clear local state
    }
    authUser.value = null;
    disconnect();
  }

  return {
    user: authUser,
    isAuthenticated,
    isConnected,
    address,
    isLoading: authLoading,
    fetchMe,
    signIn,
    signOut,
  };
}

/** Map AppKit provider name to a canonical string stored in the DB */
function inferProvider(providerName: string): string {
  const n = providerName.toLowerCase();
  if (n.includes('google')) return 'google';
  if (n.includes('github')) return 'github';
  if (n.includes('discord')) return 'discord';
  if (n === 'x' || n.includes('twitter')) return 'x';
  if (n.includes('apple')) return 'apple';
  if (n.includes('email')) return 'email';
  return 'wallet';
}

/**
 * Plugin 01 — Reown AppKit + Wagmi setup (client-side only, runs first).
 *
 * Order matters: this must run before any other plugin or middleware that
 * uses wagmi composables, because WagmiPlugin.install() must happen first.
 *
 * Supports wallet, email OTP, and social logins (Google, GitHub, Discord, X, Apple).
 * All auth types produce a wallet address used for SIWE sign-in.
 *
 * IMPORTANT: set REOWN_PROJECT_ID in .env — get a real ID from https://cloud.reown.com
 */
import { createAppKit } from '@reown/appkit/vue';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { WagmiPlugin } from '@wagmi/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { watchConnection } from '@wagmi/core';
import { base } from '@reown/appkit/networks';
import { defineNuxtPlugin, useRuntimeConfig, navigateTo } from '#app';
import { setWagmiConfig } from '~/utils/wagmi-config';
import { handleWalletDisconnect } from '~/composables/useAuth';

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig();
  const projectId = config.public.reownProjectId as string;

  if (!projectId) {
    console.warn('[AppKit] REOWN_PROJECT_ID is not set. Set it in .env to enable wallet connection.');
  }

  // 1. Create wagmi adapter (Base chain only)
  const wagmiAdapter = new WagmiAdapter({
    projectId,
    networks: [base],
  });

  // 2. Initialise Reown AppKit with social + email + wallet support
  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks: [base],
    defaultNetwork: base,
    metadata: {
      name: 'Heppy Market',
      description: 'AI-powered paper trading agents on Base chain DEXes',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://heppy.market',
      icons: [],
    },
    features: {
      analytics: false,
      email: true,
      socials: ['google', 'github', 'discord', 'x', 'apple'],
      emailShowWallets: true,
    },
    themeMode: 'dark',
  });

  // 3. Register WagmiPlugin and VueQueryPlugin on the Vue app instance
  //    This must happen before any @wagmi/vue composable is called.
  nuxtApp.vueApp.use(WagmiPlugin, { config: wagmiAdapter.wagmiConfig });
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient: new QueryClient() });

  // 4. Store the wagmi config so @wagmi/core actions can be called from
  //    composables and middleware without Vue's inject() context.
  setWagmiConfig(wagmiAdapter.wagmiConfig);

  // 5. Watch for wallet disconnection and automatically sign out of the app.
  //    Components should use useAccount() from @wagmi/vue for reactive wallet state.
  watchConnection(wagmiAdapter.wagmiConfig, {
    onChange(connection) {
      if (!connection.isConnected) {
        handleWalletDisconnect().then(() => {
          if (import.meta.client) {
            navigateTo('/connect');
          }
        });
      }
    },
  });
});

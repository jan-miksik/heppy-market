/**
 * Reown AppKit plugin — initialised client-side only.
 *
 * Supports:
 *  - Wallet connections (MetaMask, WalletConnect, Coinbase Wallet, …)
 *  - Email OTP login  → creates a Reown-managed embedded wallet
 *  - Social logins (Google, GitHub, Discord, X/Twitter, Apple) → embedded wallet
 *
 * All auth types produce a wallet address, which is then used for SIWE sign-in.
 *
 * IMPORTANT: Replace REOWN_PROJECT_ID in .env with a real ID from https://cloud.reown.com
 */
import { createAppKit } from '@reown/appkit/vue';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { WagmiPlugin } from '@wagmi/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { base } from '@reown/appkit/networks';
import { defineNuxtPlugin, useRuntimeConfig } from '#app';

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig();
  const projectId = config.public.reownProjectId as string;

  if (!projectId) {
    console.warn('[AppKit] REOWN_PROJECT_ID is not set. Wallet connection will not work.');
  }

  const wagmiAdapter = new WagmiAdapter({
    projectId,
    networks: [base],
  });

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
      email: true,           // Email OTP login (creates embedded wallet)
      socials: ['google', 'github', 'discord', 'x', 'apple'],
      emailShowWallets: true,
    },
    themeMode: 'dark',
  });

  // Register wagmi + tanstack-query plugins so useSignMessage / useAccount work
  nuxtApp.vueApp.use(WagmiPlugin, { config: wagmiAdapter.wagmiConfig });
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient: new QueryClient() });
});

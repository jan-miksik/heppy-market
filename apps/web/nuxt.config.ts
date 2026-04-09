// https://nuxt.com/docs/api/configuration/nuxt-config
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineNuxtConfig } from 'nuxt/config';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(appRoot, '..', '..');

export default defineNuxtConfig({
  devtools: { enabled: false },

  // SPA mode — all pages are client-rendered (API calls require browser context)
  ssr: false,

  // Cloudflare Pages compatible (compatibility date for Workers runtime when using Pages Functions)
  compatibilityDate: '2026-02-17',
  nitro: {
    preset: 'cloudflare-pages',
  },
  vite: {
    base: '/',
    server: {
      fs: {
        // Needed for pnpm workspace paths resolved through /_nuxt/@fs/...,
        // including Nuxt's own runtime entry under workspace-level node_modules.
        allow: [appRoot, workspaceRoot],
      },
    },
    build: {
      rollupOptions: {
        output: {
          entryFileNames: '_nuxt/[name]-[hash].js',
          chunkFileNames: '_nuxt/[name]-[hash].js',
          assetFileNames: '_nuxt/[name]-[hash].[ext]',
        },
      },
    },
  },

  runtimeConfig: {
    public: {
      // Client always uses same-origin /api (proxy). No public API URL.
      apiBase: '',
      // Initia MVP runtime config (used by connect page helpers)
      initiaRollupChainId: process.env.NUXT_PUBLIC_INITIA_ROLLUP_CHAIN_ID || 'pillow-rollup',
      initiaEvmChainId: process.env.NUXT_PUBLIC_INITIA_EVM_CHAIN_ID || '2178983797612220',
      initiaContractAddress: process.env.NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS || '0xFBF2300e65255b14d373c881dF3De3c7dd8b9b1d',
      initiaBridgeSrcChainId: process.env.NUXT_PUBLIC_INITIA_BRIDGE_SRC_CHAIN_ID || 'initiation-2',
      initiaBridgeSrcDenom: process.env.NUXT_PUBLIC_INITIA_BRIDGE_SRC_DENOM || 'uinit',
      initiaBridgeUrl: process.env.NUXT_PUBLIC_INITIA_BRIDGE_URL || 'https://bridge.testnet.initia.xyz',
      initiaEvmRpc: process.env.NUXT_PUBLIC_INITIA_EVM_RPC || 'http://localhost:8545',
      initiaRestUrl: process.env.NUXT_PUBLIC_INITIA_REST_URL || 'http://localhost:1317',
      initiaRpcUrl: process.env.NUXT_PUBLIC_INITIA_RPC_URL || 'http://localhost:26657',
      initiaIndexerUrl: process.env.NUXT_PUBLIC_INITIA_INDEXER_URL || 'http://localhost:8080',
      initiaWebUrl: process.env.NUXT_PUBLIC_INITIA_WEB_URL || 'http://localhost:5173',
      initiaShowcaseTokenAddress: process.env.NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS || '',
      initiaShowcaseTokenFaucetAddress: process.env.NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS || '',
      initiaExecutorAddress: process.env.NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS || '',
      initiaShowcaseTargetAddress: process.env.NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS || '',
      initiaExecutorMaxTradeWei: process.env.NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI || '0',
      initiaExecutorDailyLimitWei: process.env.NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI || '0',
    },
    // Server-only: upstream for API proxy when Service Binding is not present (e.g. local dev)
    apiUpstream: process.env.API_BASE_URL || 'http://localhost:8787',
    // Dev/test only: enables GET /dev-login for Playwright. Never set in production.
    playwrightSecret: process.env.PLAYWRIGHT_SECRET || '',
  },

  css: ['~/assets/css/main.css'],

  typescript: {
    strict: true,
    typeCheck: false,
  },

  // Apply auth guard to all routes
  router: {
    options: {
      scrollBehaviorType: 'smooth',
    },
  },

  // Ensure production assets use root-relative paths (avoids /_nuxt/workspace/... when build runs in /workspace)
  app: {
    baseURL: '/',
    buildAssetsDir: '_nuxt',
    head: {
      title: 'initRoot',
      meta: [
        { name: 'description', content: 'AI-powered paper trading agents with Initia MVP integration' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicon.png' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'alternate icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
        },
      ],
    },
  },
});

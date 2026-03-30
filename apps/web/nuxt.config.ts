// https://nuxt.com/docs/api/configuration/nuxt-config
import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  devtools: { enabled: false },

  // Reown AppKit uses web components (w3m-*); tell Vue not to resolve them as Vue components
  vue: {
    compilerOptions: {
      isCustomElement: (tag: string) => tag.startsWith('w3m-'),
    },
  },

  // SPA mode — all pages are client-rendered (API calls require browser context)
  ssr: false,

  // Cloudflare Pages compatible (compatibility date for Workers runtime when using Pages Functions)
  compatibilityDate: '2026-02-17',
  nitro: {
    preset: 'cloudflare-pages',
  },
  vite: {
    base: '/',
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
      // Reown AppKit project ID — replace REOWN_PROJECT_ID in .env
      reownProjectId: process.env.REOWN_PROJECT_ID || '',
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
      title: 'Something in loop',
      meta: [
        { name: 'description', content: 'AI-powered paper trading agents on Base chain DEXes' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
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

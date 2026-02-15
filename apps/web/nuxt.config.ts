// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: false },

  // SPA mode — all pages are client-rendered (API calls require browser context)
  ssr: false,

  // Cloudflare Pages compatible
  nitro: {
    preset: 'cloudflare-pages',
  },

  runtimeConfig: {
    public: {
      apiBase: process.env.API_BASE_URL ?? 'http://localhost:8787',
    },
  },

  css: ['~/assets/css/main.css'],

  typescript: {
    strict: true,
    typeCheck: false,
  },

  app: {
    head: {
      title: 'DEX Trading Agents',
      meta: [
        { name: 'description', content: 'AI-powered paper trading agents on Base chain DEXes' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
        },
      ],
    },
  },
});

# OpenRouter OAuth/PKCE Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users connect their own OpenRouter account via PKCE OAuth, unlocking paid models for their agents and managers, with AES-GCM encrypted key storage in D1.

**Architecture:** Frontend generates PKCE verifier/challenge and redirects to OpenRouter. On callback, the code+verifier is sent to the backend which exchanges it with OpenRouter, encrypts the resulting `sk-or-v1-…` key with AES-GCM using a server secret, and stores it on the user record. Agent-loop and manager-loop decrypt and prefer the user's key over the shared server key. Model selectors unlock a paid-model group + free-text input when the user has a key.

**Tech Stack:** Cloudflare Workers (Web Crypto API for AES-GCM), D1/Drizzle, Hono, Nuxt 4 SPA, `@wagmi/vue`, existing `useAuth` composable.

---

## Task 1: Encryption utility

**Files:**
- Create: `apps/api/src/lib/crypto.ts`
- Modify: `apps/api/src/types/env.ts`

**Context:**
Uses `crypto.subtle` (available in Workers). AES-GCM with a 256-bit key derived from `KEY_ENCRYPTION_SECRET` env var (hex string). Each encrypt call generates a fresh 12-byte IV; output is `base64(iv[12] + ciphertext)`.

**Step 1: Add env var to `apps/api/src/types/env.ts`**

```typescript
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace<TradingAgentDO>;
  AGENT_MANAGER: DurableObjectNamespace<AgentManagerDO>;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  KEY_ENCRYPTION_SECRET?: string;   // 64-char hex (32 bytes). If absent, keys stored plain.
  CORS_ORIGINS?: string;
  BASE_RPC_URL?: string;
}
```

**Step 2: Create `apps/api/src/lib/crypto.ts`**

```typescript
/**
 * AES-GCM encrypt/decrypt for storing user API keys in D1.
 * Uses Web Crypto API (available in Cloudflare Workers).
 *
 * If no secret is provided, falls back to plain-text (dev mode).
 * Format: base64(iv[12 bytes] + ciphertext)
 */

async function deriveKey(secret: string): Promise<CryptoKey> {
  const raw = new Uint8Array(
    secret.match(/.{2}/g)!.map((h) => parseInt(h, 16))
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptKey(
  plaintext: string,
  secret: string | undefined
): Promise<string> {
  if (!secret) return plaintext; // dev fallback
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  const buf = new Uint8Array(12 + ciphertext.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...buf));
}

export async function decryptKey(
  stored: string,
  secret: string | undefined
): Promise<string> {
  if (!secret) return stored; // dev fallback
  const buf = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  const key = await deriveKey(secret);
  const dec = new TextDecoder();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return dec.decode(plain);
}
```

**Step 3: Generate a secret and add to `.dev.vars`**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the output to `apps/api/.dev.vars`:
```
KEY_ENCRYPTION_SECRET=<64-char hex>
```

**Step 4: Type-check**
```bash
pnpm --filter @dex-agents/api exec tsc --noEmit
```
Expected: no errors.

**Step 5: Commit**
```bash
git add apps/api/src/lib/crypto.ts apps/api/src/types/env.ts apps/api/.dev.vars
git commit -m "feat(crypto): add AES-GCM encrypt/decrypt for user API key storage"
```

---

## Task 2: DB migration — add `openrouter_key` to users

**Files:**
- Create: `apps/api/src/db/migrations/0006_openrouter_key.sql`
- Modify: `apps/api/src/db/schema.ts`

**Step 1: Create `0006_openrouter_key.sql`**

```sql
-- Migration: 0006_openrouter_key
-- Store encrypted OpenRouter API key per user (null = not connected)
ALTER TABLE users ADD COLUMN openrouter_key TEXT;
```

**Step 2: Update `apps/api/src/db/schema.ts` — add column to users table**

In the `users` table definition, after the `role` field add:
```typescript
/** AES-GCM encrypted OpenRouter key. null = not connected, uses server fallback key. */
openRouterKey: text('openrouter_key'),
```

**Step 3: Run migration locally**
```bash
npx wrangler d1 execute trading-agents --local --config=apps/api/wrangler.toml \
  --file=apps/api/src/db/migrations/0006_openrouter_key.sql
```
Expected: `1 command executed successfully`.

**Step 4: Type-check**
```bash
pnpm --filter @dex-agents/api exec tsc --noEmit
```

**Step 5: Commit**
```bash
git add apps/api/src/db/migrations/0006_openrouter_key.sql apps/api/src/db/schema.ts
git commit -m "feat(db): add openrouter_key column to users"
```

---

## Task 3: Backend — exchange + disconnect endpoints

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Context:**
OpenRouter exchange API: `POST https://openrouter.ai/api/v1/auth/keys` with JSON body `{ code, code_verifier }` returns `{ key: "sk-or-v1-…" }`.

**Step 1: Add two new routes to `apps/api/src/routes/auth.ts`**

After the logout route, add:

```typescript
/** POST /api/auth/openrouter/exchange — exchange PKCE code for OR key, encrypt, store */
authRoute.post('/openrouter/exchange', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ code?: string; code_verifier?: string }>();
  if (!body.code || !body.code_verifier) {
    return c.json({ error: 'Missing code or code_verifier' }, 400);
  }

  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: body.code, code_verifier: body.code_verifier }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[auth/openrouter/exchange] OpenRouter error:', res.status, text);
    return c.json({ error: 'OpenRouter exchange failed' }, 502);
  }

  const data = await res.json<{ key?: string }>();
  if (!data.key) return c.json({ error: 'No key in OpenRouter response' }, 502);

  const encrypted = await encryptKey(data.key, c.env.KEY_ENCRYPTION_SECRET);
  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: encrypted, updatedAt: nowIso() })
    .where(eq(users.id, session.userId));

  return c.json({ ok: true });
});

/** DELETE /api/auth/openrouter/disconnect — remove stored OR key */
authRoute.delete('/openrouter/disconnect', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: null, updatedAt: nowIso() })
    .where(eq(users.id, session.userId));

  return c.json({ ok: true });
});
```

**Step 2: Add imports at the top of `auth.ts`**

Add to existing imports:
```typescript
import { encryptKey } from '../lib/crypto.js';
import { nowIso } from '../lib/utils.js';
```
(Check `nowIso` isn't already imported — it may already be there.)

**Step 3: Update `/me` and `/verify` responses to include `openRouterKeySet`**

In both `GET /me` and `POST /verify` response objects, add:
```typescript
openRouterKeySet: !!user.openRouterKey,
```

**Step 4: Type-check**
```bash
pnpm --filter @dex-agents/api exec tsc --noEmit
```

**Step 5: Commit**
```bash
git add apps/api/src/routes/auth.ts
git commit -m "feat(auth): add OpenRouter PKCE exchange and disconnect endpoints"
```

---

## Task 4: Agent-loop + manager-loop — prefer user's OR key

**Files:**
- Modify: `apps/api/src/agents/agent-loop.ts`
- Modify: `apps/api/src/agents/manager-loop.ts`

**Context:**
In `agent-loop.ts`, the `env.OPENROUTER_API_KEY` check is at line ~452. We need to look up the owner's decrypted key first and use it if present. The owner wallet is `agentRow.ownerAddress`.

In `manager-loop.ts`, find where `env.OPENROUTER_API_KEY` is used and apply the same pattern.

**Step 1: Update `agent-loop.ts` — add import and key resolution**

Add import at top:
```typescript
import { decryptKey } from '../lib/crypto.js';
```

In the `else` branch (OpenRouter path), replace the simple `llmApiKey = env.OPENROUTER_API_KEY` with:

```typescript
  } else {
    // Prefer user's own OR key; fall back to server key
    let resolvedKey = env.OPENROUTER_API_KEY;
    const ownerAddr = agentRow.ownerAddress?.toLowerCase();
    if (ownerAddr) {
      const [ownerUser] = await db
        .select({ openRouterKey: users.openRouterKey })
        .from(users)
        .where(eq(users.walletAddress, ownerAddr));
      if (ownerUser?.openRouterKey) {
        try {
          resolvedKey = await decryptKey(ownerUser.openRouterKey, env.KEY_ENCRYPTION_SECRET);
        } catch {
          console.warn(`[agent-loop] ${agentId}: failed to decrypt user OR key, falling back to server key`);
        }
      }
    }
    if (!resolvedKey) {
      // (existing OPENROUTER_API_KEY missing error block — keep as-is)
    }
    llmApiKey = resolvedKey;
  }
```

**Step 2: Update `manager-loop.ts` — same pattern**

Find where `createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })` is called. Add the same lookup: get the manager's `ownerAddress`, look up their `openRouterKey`, decrypt it, fall back to `env.OPENROUTER_API_KEY`.

```typescript
import { decryptKey } from '../lib/crypto.js';
// ...
// before createOpenRouter:
let orApiKey = env.OPENROUTER_API_KEY;
const [ownerUser] = await orm
  .select({ openRouterKey: users.openRouterKey })
  .from(users)
  .where(eq(users.walletAddress, managerRow.ownerAddress.toLowerCase()));
if (ownerUser?.openRouterKey) {
  try {
    orApiKey = await decryptKey(ownerUser.openRouterKey, env.KEY_ENCRYPTION_SECRET);
  } catch {
    console.warn('[manager-loop] failed to decrypt user OR key, using server fallback');
  }
}
const openrouter = createOpenRouter({ apiKey: orApiKey });
```

**Step 3: Type-check**
```bash
pnpm --filter @dex-agents/api exec tsc --noEmit
```

**Step 4: Commit**
```bash
git add apps/api/src/agents/agent-loop.ts apps/api/src/agents/manager-loop.ts
git commit -m "feat(agents): use user's own OpenRouter key when available"
```

---

## Task 5: Relax ManagerConfigSchema llmModel enum

**Files:**
- Modify: `packages/shared/src/validation.ts`

**Context:**
`ManagerConfigSchema.llmModel` is currently `z.enum(FREE_MANAGER_MODELS)`. We need to allow any string so users with their own key can pick paid models. Keep `FREE_MANAGER_MODELS` for the default value only.

**Step 1: Update `ManagerConfigSchema` in `packages/shared/src/validation.ts`**

Change:
```typescript
export const ManagerConfigSchema = z.object({
  llmModel: z.enum(FREE_MANAGER_MODELS).default('nvidia/nemotron-3-nano-30b-a3b:free'),
```
To:
```typescript
export const ManagerConfigSchema = z.object({
  llmModel: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
```

Also update `CreateManagerRequestSchema` the same way (same field).

**Step 2: Type-check**
```bash
pnpm --filter @dex-agents/api exec tsc --noEmit
pnpm --filter @dex-agents/web exec tsc --noEmit 2>/dev/null || true
```

**Step 3: Commit**
```bash
git add packages/shared/src/validation.ts
git commit -m "feat(schema): allow any llmModel string for managers (paid model support)"
```

---

## Task 6: Frontend — `useAuth` + `useOpenRouter` composable

**Files:**
- Modify: `apps/web/composables/useAuth.ts`
- Create: `apps/web/composables/useOpenRouter.ts`

**Step 1: Update `AuthUser` interface in `useAuth.ts`**

Add field:
```typescript
openRouterKeySet: boolean;
```

**Step 2: Create `apps/web/composables/useOpenRouter.ts`**

```typescript
/**
 * useOpenRouter — PKCE OAuth flow for connecting a user's OpenRouter account.
 *
 * Flow:
 *  1. initConnect() — generates verifier+challenge, stores verifier in sessionStorage,
 *                     redirects to openrouter.ai/auth
 *  2. handleCallback(code) — called from /openrouter/callback page, sends code+verifier
 *                            to backend /api/auth/openrouter/exchange
 *  3. disconnect() — calls DELETE /api/auth/openrouter/disconnect
 */
import { navigateTo } from '#app';

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
```

**Step 3: Commit**
```bash
git add apps/web/composables/useAuth.ts apps/web/composables/useOpenRouter.ts
git commit -m "feat(web): add openRouterKeySet to AuthUser + useOpenRouter PKCE composable"
```

---

## Task 7: Frontend — `/openrouter/callback` page

**Files:**
- Create: `apps/web/pages/openrouter/callback.vue`

**Step 1: Create the page**

```vue
<script setup lang="ts">
// This page is the OAuth redirect target from openrouter.ai.
// It reads ?code=..., exchanges it via the backend, then redirects home.
definePageMeta({ layout: false });

const { handleCallback } = useOpenRouter();
const { fetchMe } = useAuth();
const status = ref<'loading' | 'success' | 'error'>('loading');
const errorMsg = ref('');

onMounted(async () => {
  const code = useRoute().query.code as string | undefined;
  if (!code) {
    status.value = 'error';
    errorMsg.value = 'No code in callback URL.';
    return;
  }
  try {
    await handleCallback(code);
    await fetchMe(); // refresh user so openRouterKeySet updates
    status.value = 'success';
    setTimeout(() => navigateTo('/'), 1500);
  } catch (err) {
    status.value = 'error';
    errorMsg.value = (err as Error).message ?? 'Exchange failed.';
  }
});
</script>

<template>
  <div class="callback-root">
    <div class="callback-card">
      <template v-if="status === 'loading'">
        <div class="callback-spinner" />
        <p>Connecting OpenRouter…</p>
      </template>
      <template v-else-if="status === 'success'">
        <p class="callback-ok">OpenRouter connected. Redirecting…</p>
      </template>
      <template v-else>
        <p class="callback-err">{{ errorMsg }}</p>
        <NuxtLink to="/connect">Try again</NuxtLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.callback-root {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.callback-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 40px 48px;
  text-align: center;
  color: var(--text);
}
.callback-spinner {
  width: 28px; height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  margin: 0 auto 16px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.callback-ok { color: var(--success, #22c55e); }
.callback-err { color: var(--danger, #ef4444); margin-bottom: 12px; }
</style>
```

**Step 2: Commit**
```bash
git add apps/web/pages/openrouter/callback.vue
git commit -m "feat(web): add /openrouter/callback page for PKCE exchange"
```

---

## Task 8: Frontend — update `/connect` page (step 2)

**Files:**
- Modify: `apps/web/pages/connect.vue`

**Context:**
After the user signs in (SIWE), show a second step: "Connect OpenRouter" with Connect button and a Skip link. Check `user.value?.openRouterKeySet` to show connected state.

**Step 1: Add OpenRouter step to `connect.vue`**

In the `<script setup>`, add:
```typescript
const { initConnect } = useOpenRouter();
const connectingOR = ref(false);
async function handleConnectOR() {
  connectingOR.value = true;
  await initConnect(); // redirects away
}
```

In the template, after the existing sign-in card content, add a second step that only shows when `isAuthenticated`:
```html
<div v-if="isAuthenticated" class="connect-step2">
  <div class="step-label">Step 2 <span class="step-opt">(optional)</span></div>
  <h3 class="step-title">Connect OpenRouter</h3>
  <p class="step-desc">
    Unlock paid models (GPT-5, Claude, Gemini…) using your own OpenRouter account.
    Your key is stored encrypted and never shared.
  </p>
  <template v-if="user?.openRouterKeySet">
    <span class="or-connected">OpenRouter connected</span>
    <NuxtLink to="/" class="btn btn-primary btn-sm" style="margin-left:12px">Continue →</NuxtLink>
  </template>
  <template v-else>
    <button class="btn btn-primary" :disabled="connectingOR" @click="handleConnectOR">
      {{ connectingOR ? 'Redirecting…' : 'Connect OpenRouter →' }}
    </button>
    <NuxtLink to="/" class="skip-link">Skip for now</NuxtLink>
  </template>
</div>
```

**Step 2: Commit**
```bash
git add apps/web/pages/connect.vue
git commit -m "feat(web): add OpenRouter connect step to /connect page"
```

---

## Task 9: Frontend — `/settings` page + settings icon in navbar

**Files:**
- Create: `apps/web/pages/settings.vue`
- Modify: `apps/web/app.vue`

**Step 1: Create `apps/web/pages/settings.vue`**

```vue
<script setup lang="ts">
definePageMeta({ middleware: 'auth' }); // redirect to /connect if not authed
const { user, fetchMe } = useAuth();
const { initConnect, disconnect } = useOpenRouter();

const disconnecting = ref(false);
const connecting = ref(false);

async function handleDisconnect() {
  disconnecting.value = true;
  try {
    await disconnect();
    await fetchMe();
  } finally {
    disconnecting.value = false;
  }
}
async function handleConnect() {
  connecting.value = true;
  await initConnect();
}
</script>

<template>
  <div class="settings-root">
    <h1 class="settings-title">Settings</h1>

    <section class="settings-section">
      <h2 class="settings-section-title">OpenRouter</h2>
      <p class="settings-section-desc">
        Connect your OpenRouter account to use paid models (GPT-5, Claude, Gemini, DeepSeek…).
        Your key is AES-256 encrypted at rest.
      </p>
      <div class="settings-row">
        <template v-if="user?.openRouterKeySet">
          <span class="or-status or-status--connected">Connected</span>
          <button class="btn btn-ghost btn-sm" :disabled="disconnecting" @click="handleDisconnect">
            {{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}
          </button>
        </template>
        <template v-else>
          <span class="or-status or-status--none">Not connected</span>
          <button class="btn btn-primary btn-sm" :disabled="connecting" @click="handleConnect">
            {{ connecting ? 'Redirecting…' : 'Connect OpenRouter →' }}
          </button>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-root { max-width: 560px; margin: 48px auto; padding: 0 24px; }
.settings-title { font-size: 20px; font-weight: 700; margin-bottom: 32px; color: var(--text); }
.settings-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.settings-section-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.settings-section-desc { font-size: 13px; color: var(--text-dim); margin-bottom: 20px; line-height: 1.5; }
.settings-row { display: flex; align-items: center; gap: 12px; }
.or-status { font-size: 13px; font-weight: 500; }
.or-status--connected { color: var(--success, #22c55e); }
.or-status--none { color: var(--text-dim); }
</style>
```

**Step 2: Add settings icon to `app.vue` navbar**

In `app.vue`, inside `.navbar-auth` before the wallet button (only show when authenticated):

```html
<template v-if="isAuthenticated">
  <NuxtLink to="/settings" class="settings-icon-btn" title="Settings">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="1.5"/>
      <path d="M13.3 6.6l-.8-.5a5.1 5.1 0 0 0 0-2.2l.8-.5a1 1 0 0 0 .4-1.3l-.8-1.4a1 1 0 0 0-1.3-.4l-.8.5A5.1 5.1 0 0 0 9 .4V-.4..." stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </NuxtLink>
</template>
```

> **Note:** Use a simple gear SVG inline. Keep it minimal — just the icon, no text. Style it to match `.wallet-trigger` (same border, padding, size).

Add to `app.vue` styles:
```css
.settings-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  margin-right: 8px;
  transition: background 0.15s, color 0.15s;
}
.settings-icon-btn:hover {
  background: var(--bg-secondary);
  color: var(--text);
}
```

**Step 3: Commit**
```bash
git add apps/web/pages/settings.vue apps/web/app.vue
git commit -m "feat(web): add /settings page and settings icon in navbar"
```

---

## Task 10: Frontend — update model selectors (AgentConfigForm + ManagerConfigForm)

**Files:**
- Modify: `apps/web/components/AgentConfigForm.vue`
- Modify: `apps/web/components/ManagerConfigForm.vue`

**Context:**
Each form needs: free models group (unchanged + MiMo Flash added), paid models group (hidden without OR key), custom text input (hidden without OR key), OpenRouter link, and an inline nudge when no key.

**Step 1: Add shared model constants**

At the top of each form's `<script setup>` (or extract to a shared composable if you prefer), add:

```typescript
const PAID_MODELS = [
  { id: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro',       ctx: '2M',   price: '$2/$12' },
  { id: 'anthropic/claude-sonnet-4.6',    label: 'Claude Sonnet 4.6',    ctx: '1M',   price: '$3/$15' },
  { id: 'google/gemini-3.1-flash-lite',   label: 'Gemini 3.1 Flash Lite',ctx: '1M',   price: '$0.25/$1.50' },
  { id: 'openai/gpt-5.4',                 label: 'GPT-5.4',              ctx: '1M',   price: '$2.50/$20' },
  { id: 'deepseek/deepseek-v3.2',         label: 'DeepSeek V3.2',        ctx: '128K', price: '$0.25/$0.38' },
  { id: 'anthropic/claude-opus-4.6',      label: 'Claude Opus 4.6',      ctx: '200K', price: '$5/$25' },
] as const;
```

**Step 2: Add `hasOwnKey` computed + custom model ref in `AgentConfigForm.vue`**

```typescript
const { user } = useAuth();  // already imported
const hasOwnKey = computed(() => !!user.value?.openRouterKeySet);
const customModel = ref('');

// When custom model input changes, update form.llmModel
watch(customModel, (val) => {
  if (val.trim()) form.llmModel = val.trim();
});
```

**Step 3: Replace model `<select>` in `AgentConfigForm.vue`**

```html
<div class="form-group">
  <label class="form-label">LLM Model</label>
  <select v-model="form.llmModel" class="form-select">
    <optgroup label="Free models (OpenRouter)">
      <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nemotron-30B (free)</option>
      <option value="stepfun/step-3.5-flash:free">Step-3.5 Flash (free)</option>
      <option value="nvidia/nemotron-nano-9b-v2:free">Nemotron-9B (free)</option>
      <option value="arcee-ai/trinity-large-preview:free">Trinity-Large (free)</option>
      <option value="xiaomi/mimo-v2-flash:free">MiMo Flash · 256K (free)</option>
    </optgroup>
    <optgroup v-if="hasOwnKey" label="Paid (your OpenRouter key)">
      <option v-for="m in PAID_MODELS" :key="m.id" :value="m.id">
        {{ m.label }} · {{ m.ctx }} · {{ m.price }}
      </option>
    </optgroup>
    <optgroup v-if="isTester" label="Anthropic direct (tester)">
      <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
    </optgroup>
  </select>

  <!-- Custom model input (own key only) -->
  <template v-if="hasOwnKey">
    <input
      v-model="customModel"
      class="form-input"
      style="margin-top: 8px"
      placeholder="Or type any model ID…"
    />
    <a
      href="https://openrouter.ai/models"
      target="_blank"
      rel="noopener"
      class="model-browse-link"
    >Browse all models at openrouter.ai/models ↗</a>
  </template>

  <!-- Nudge for users without a key -->
  <p v-else class="model-nudge">
    <NuxtLink to="/settings">Connect your OpenRouter key</NuxtLink> to unlock paid models.
  </p>
</div>
```

Add to component styles:
```css
.model-browse-link {
  display: block;
  font-size: 12px;
  color: var(--accent);
  margin-top: 4px;
}
.model-nudge {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 6px;
}
.model-nudge a {
  color: var(--accent);
}
```

**Step 4: Apply same pattern to `ManagerConfigForm.vue`**

Identical changes: add `PAID_MODELS`, `hasOwnKey`, `customModel`, replace model `<select>`. No tester optgroup needed for managers.

**Step 5: Update `shortModelName` in both forms to include paid models**

```typescript
const PAID_MODEL_NAMES: Record<string, string> = Object.fromEntries(
  PAID_MODELS.map((m) => [m.id, m.label])
);

function shortModelName(m: string): string {
  const n: Record<string, string> = {
    'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron-30B',
    'stepfun/step-3.5-flash:free': 'Step-3.5',
    'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
    'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
    'xiaomi/mimo-v2-flash:free': 'MiMo Flash',
    'claude-sonnet-4-5': 'Claude Sonnet',
    'claude-haiku-4-5': 'Claude Haiku',
    ...PAID_MODEL_NAMES,
  };
  return n[m] ?? m.split('/').pop()?.split(':')[0] ?? 'Agent';
}
```

**Step 6: Commit**
```bash
git add apps/web/components/AgentConfigForm.vue apps/web/components/ManagerConfigForm.vue
git commit -m "feat(web): unlock paid models and custom model input when OR key connected"
```

---

## Task 11: Wire up + smoke test

**Step 1: Run migrations for production (when ready)**
```bash
npx wrangler d1 execute trading-agents --remote --config=apps/api/wrangler.toml \
  --env production --file=apps/api/src/db/migrations/0006_openrouter_key.sql
```

**Step 2: Set production secrets**
```bash
npx wrangler secret put KEY_ENCRYPTION_SECRET --env production
# paste the same 64-char hex you generated in Task 1
```

**Step 3: Manual smoke test checklist**
- [ ] Sign in → `/connect` shows Step 2 with Connect button
- [ ] Click Connect → redirected to openrouter.ai
- [ ] After auth → `/openrouter/callback` shows spinner, then "Connected", then redirects home
- [ ] `GET /api/auth/me` returns `openRouterKeySet: true`
- [ ] Agent config form shows Paid models group + custom input
- [ ] Settings page (gear icon) shows "Connected" + Disconnect button
- [ ] Disconnect → `openRouterKeySet` false → paid group disappears from form
- [ ] Agent with paid model runs analysis → check worker logs show user key used

**Step 4: Final commit**
```bash
git add .
git commit -m "feat: OpenRouter PKCE OAuth — connect, store encrypted key, unlock paid models"
```

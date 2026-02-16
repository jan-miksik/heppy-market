# Deploy to Cloudflare

This guide covers deploying both parts of the app:

- **API** (Hono on Cloudflare Workers) — D1, KV, Durable Objects
- **Web** (Nuxt on Cloudflare Pages) — frontend

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and logged in: `npm install -g wrangler && wrangler login`
- OpenRouter API key (for LLM) — set as a Worker secret

---

## 1. Deploy the API (Workers)

### 1.1 Create production resources

From the repo root:

```bash
cd apps/api
```

**Create D1 database (production):**

```bash
wrangler d1 create trading-agents
```

Copy the `database_id` from the output (UUID).

**Create KV namespace (production):**

```bash
wrangler kv namespace create "CACHE"
```

Copy the `id` from the output.

### 1.2 Configure production in wrangler.toml

Edit `apps/api/wrangler.toml` and replace the placeholders in the `[env.production]` section:

- `database_id = "<YOUR_PRODUCTION_D1_DATABASE_ID>"` → paste the D1 UUID
- `id = "<YOUR_PRODUCTION_KV_NAMESPACE_ID>"` → paste the KV namespace id

### 1.3 Run D1 migrations (production)

```bash
cd apps/api
wrangler d1 migrations apply trading-agents --env production
```

(First time may prompt to create the remote DB; use the same `database_name` and the `database_id` you put in wrangler.toml.)

### 1.4 Set secrets

```bash
cd apps/api
wrangler secret put OPENROUTER_API_KEY --env production
# Paste your OpenRouter API key when prompted
```

Optional: `ANTHROPIC_API_KEY` for paid Claude models.

### 1.5 Deploy the Worker

```bash
cd apps/api
npm run deploy -- --env production
# or: wrangler deploy --env production
```

Note the deployed URL, e.g. `https://dex-trading-agents-api.<your-subdomain>.workers.dev`.

### 1.6 Allow your frontend in CORS (if needed)

If your Pages URL is not `https://dex-trading-agents.pages.dev`, set the Worker secret **CORS_ORIGINS** (comma-separated list of origins):

```bash
cd apps/api
wrangler secret put CORS_ORIGINS --env production
# Enter e.g.: https://your-project.pages.dev,https://yourdomain.com
```

Then redeploy the API. The app already allows localhost and `dex-trading-agents.pages.dev` by default.

---

## 2. Deploy the Web (Pages)

Two options: **Git integration** (recommended) or **Direct upload**.

### Option A: Git integration (recommended)

1. Push your repo to **GitHub** or **GitLab**.
2. In [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Select the repo and configure:
   - **Production branch:** `main`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist` (Nuxt with `nitro.preset: cloudflare-pages` outputs to `dist` in the app directory).
- **Root directory (if using Git):** `apps/web` so the build runs from the web app; build command `npm run build`, output `dist`.
4. **Environment variables** (Settings → Environment variables):
   - `API_BASE_URL` = your Worker URL, e.g. `https://dex-trading-agents-api.<subdomain>.workers.dev`
   - Add for **Production** (and Preview if you want).
5. Save and deploy. Your app will be at `https://<project-name>.pages.dev` (or your custom domain).

### Option B: Direct upload (CLI)

From repo root:

```bash
# Build the web app (from root so workspaces resolve)
npm run build --workspace=@dex-agents/web
```

Then deploy the built output. Nuxt outputs to `apps/web/dist`. Use the [Pages direct upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) flow, or:

```bash
cd apps/web
npx wrangler pages deploy dist --project-name=dex-trading-agents
```

(Replace `dex-trading-agents` with your Pages project name if different.)

After the first deploy, set **Environment variables** in the Pages project (e.g. `API_BASE_URL`) in the dashboard.

---

## 3. Point the frontend at the API

The Nuxt app uses `runtimeConfig.public.apiBase` (default from `API_BASE_URL`).

- **Git integration:** set `API_BASE_URL` in the Pages project’s Environment variables to your Worker URL.
- **Local build:** you can set `API_BASE_URL` at build time, e.g. in the build command or in a `.env` used by the build.

---

## 4. Quick reference

| Step              | Command / action |
|-------------------|-------------------|
| Create D1         | `wrangler d1 create trading-agents` (in `apps/api`) |
| Create KV         | `wrangler kv namespace create "CACHE"` (in `apps/api`) |
| Edit wrangler.toml| Set production `database_id` and KV `id` under `[env.production]` |
| Apply migrations  | `wrangler d1 migrations apply trading-agents --env production` (in `apps/api`) |
| Set API key       | `wrangler secret put OPENROUTER_API_KEY --env production` (in `apps/api`) |
| Deploy API        | `npm run deploy -- --env production` in `apps/api` |
| Deploy Web        | Git connect or `wrangler pages deploy` with built output |

---

## 5. Monorepo deploy scripts (from root)

Convenience scripts are in the root `package.json`:

- **`npm run deploy:api`** — deploys the Worker (run from repo root after configuring production and applying migrations).
- **`npm run deploy:web`** — builds the web app and deploys to Pages (set `CF_PAGES_PROJECT_NAME` or edit the script to match your project name).

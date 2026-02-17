# Deploy to Cloudflare

This guide covers deploying both parts of the app:

- **API** (Hono on Cloudflare Workers) — D1, KV, Durable Objects
- **Web** (Nuxt on Cloudflare Pages) — frontend

---

## One-time setup (do this first)

Complete these steps once before deploying.

### 1. Cloudflare account

- Sign up or log in at [dash.cloudflare.com](https://dash.cloudflare.com).

### 2. Node.js

- Install **Node.js 20+** (required for the project). Check with: `node --version`.

### 3. Install and log in with Wrangler

Wrangler is the CLI for Cloudflare Workers, D1, KV, and Pages. You must be logged in before any `wrangler` commands will work.

```bash
# Install Wrangler globally (or use npx)
npm install -g wrangler

# Log in to Cloudflare (opens browser; complete the auth flow)
wrangler login
```

After `wrangler login`, you should see a success message. If a command fails with an auth error, run `wrangler login` again.

### 4. OpenRouter API key (for the API Worker)

- Get an API key from [openrouter.ai](https://openrouter.ai) → Dashboard → API Keys.
- You will set it as a Worker secret when deploying the API (step 1.4).

### 5. Build the shared package (monorepo)

From the repo root, build the shared package so the API can be built and deployed:

```bash
npm run build --workspace=@dex-agents/shared
```

(Turbo also runs this automatically when you run `npm run build` from the root.)

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
   - **Root directory:** `apps/web` (so the build runs in the web app).
   - **Production branch:** `main`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
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
| **Wrangler login**| `wrangler login` (once; opens browser) |
| Build shared      | `npm run build --workspace=@dex-agents/shared` (from repo root) |
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

---

## Troubleshooting

- **"Authentication error" or "Unauthorized" when running wrangler**  
  Run `wrangler login` again and complete the browser flow. Session can expire.

- **API deploy fails with "rootDir" or missing shared types**  
  Build the shared package first: `npm run build --workspace=@dex-agents/shared`, then deploy the API.

- **D1 migrations prompt about creating remote DB**  
  Use the same `database_name` as in your wrangler.toml and the `database_id` you copied from `wrangler d1 create`.

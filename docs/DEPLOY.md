# Deploy to Cloudflare

This guide covers deploying both parts of the app:

- **API** (Hono on Cloudflare Workers) — D1, KV, Durable Objects
- **Web** (Nuxt on Cloudflare Pages) — frontend

## Architecture: Internal-only API (recommended)

The API Worker is **not exposed publicly**. Pages talks to it via a **Service Binding** (internal-only):

```
User → Cloudflare Pages (public) → Pages Functions → [Service Binding] → Worker (private) → D1 / KV
```

- **No public API endpoint** — no custom domain or `workers.dev` route for the API.
- **No Zero Trust / tokens** — traffic stays inside Cloudflare.
- **No CORS** — the browser only talks to your Pages origin; the server proxies to the Worker.

To get this, deploy the Worker **without adding any routes**, then add a Service Binding in your Pages project (see below).

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

**Do not add a route** for this Worker (no custom domain, no `workers.dev` in frontends). It runs as a **service** and is only reachable via the Pages Service Binding.

### 1.6 Add Service Binding in Pages (so the web app can call the API)

The frontend calls `/api/*` on your Pages domain; a server route proxies to the Worker via the binding.

**Option 1 — Wrangler (recommended if you deploy from CLI)**  
The repo already has `apps/web/wrangler.toml` with:

```toml
[[services]]
binding = "API"
service = "dex-trading-agents-api"
```

If you deploy with `wrangler pages deploy dist` from `apps/web`, this binding is used. Ensure the Worker name `dex-trading-agents-api` matches `apps/api/wrangler.toml`.

**Option 2 — Cloudflare Dashboard (Git-based Pages)**  
1. Workers & Pages → your Pages project → **Settings** → **Functions**.
2. **Service bindings** → **Add**.
3. **Variable name:** `API`  
4. **Service:** choose `dex-trading-agents-api`.  
5. Save and redeploy the Pages project.

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
   When using the Service Binding (internal API), you do **not** need `API_BASE_URL` in production.  
   For **local dev** only, you can set `API_BASE_URL=http://localhost:8787` so the dev server proxy knows where the API runs.
5. Add the **Service Binding** (step 1.6) if you use the dashboard; then save and deploy. Your app will be at `https://<project-name>.pages.dev` (or your custom domain).

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

After the first deploy, add the **Service Binding** in the dashboard (step 1.6) if not using `apps/web/wrangler.toml`. You do not need `API_BASE_URL` in production when using the internal API.

---

## 3. How the frontend talks to the API

- The browser always calls **same-origin** `/api/*` (e.g. `https://your-project.pages.dev/api/agents`). No public Worker URL is used.
- A Nuxt server route (`server/api/[...path].ts`) handles these requests: on Pages it uses the **API** Service Binding to call the Worker internally; in local dev it proxies to `API_BASE_URL` (default `http://localhost:8787`).
- **Production:** no `API_BASE_URL` needed.  
- **Local dev:** run the API with `npm run dev:api` and optionally set `API_BASE_URL=http://localhost:8787` so the Nuxt dev server knows the upstream.

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

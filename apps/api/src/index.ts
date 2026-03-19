import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types/env.js';
import type { AuthVariables } from './lib/auth.js';
import { createAuthMiddleware } from './lib/auth.js';
import { createRateLimitMiddleware } from './lib/rate-limit.js';
import healthRoute from './routes/health.js';
import pairsRoute from './routes/pairs.js';
import agentsRoute from './routes/agents.js';
import tradesRoute from './routes/trades.js';
import authRoute from './routes/auth.js';
import { snapshotAllAgents } from './services/snapshot.js';
import { listFreeModels } from './services/llm-router.js';
import { handleLlmQueueBatch } from './lib/llm-queue.js';
import { getSession, parseCookieValue } from './lib/auth.js';
import comparisonRoute from './routes/comparison.js';
import managersRoute from './routes/managers.js';
import profilesRoute from './routes/profiles.js';

// Export Durable Object class (required for Workers runtime to register it)
export { TradingAgentDO } from './agents/trading-agent.js';
export { AgentManagerDO } from './agents/agent-manager.js';
export { GlobalRateLimiterDO } from './lib/global-rate-limiter.js';

function cronToMs(cron: string): number | null {
  switch (cron) {
    case '*/15 * * * *':
      return 15 * 60_000;
    case '0 * * * *':
      return 60 * 60_000;
    case '0 */4 * * *':
      return 4 * 60 * 60_000;
    case '0 0 * * *':
      return 24 * 60 * 60_000;
    default:
      return null;
  }
}

async function shouldRunCron(cron: string, env: Env): Promise<boolean> {
  const key = `cron:last:${cron}`;
  const now = Date.now();

  let lastRun = 0;
  try {
    const stored = await env.CACHE.get(key);
    if (stored) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed)) lastRun = parsed;
    }
  } catch {
    // If KV is unavailable for any reason, fall back to always running the cron.
    return true;
  }

  const intervalMs = cronToMs(cron);
  if (lastRun && intervalMs && now - lastRun < intervalMs * 0.8) {
    console.log(
      `[cron] Skipping duplicate run for ${cron}. lastRun=${new Date(
        lastRun
      ).toISOString()} now=${new Date(now).toISOString()}`
    );
    return false;
  }

  try {
    await env.CACHE.put(key, String(now), { expirationTtl: 24 * 60 * 60 });
  } catch {
    // Non-fatal; cron can still proceed even if we fail to record the timestamp.
  }

  return true;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Global per-IP rate limit — broad defence against scraping and DoS.
// Applied before auth so even unauthenticated traffic is bounded.
// Generous limit (200/min) to avoid false positives on legitimate use.
app.use(
  '/api/*',
  createRateLimitMiddleware<{ Bindings: Env; Variables: AuthVariables }>({
    limit: 200,
    windowSecs: 60,
  })
);

// Stricter limits on unauthenticated auth endpoints — protect against brute-force
// on nonce/verify (these are the only paths reachable without a valid session).
app.use(
  '/api/auth/nonce',
  createRateLimitMiddleware<{ Bindings: Env; Variables: AuthVariables }>({
    limit: 10,
    windowSecs: 300, // 10 nonce requests per 5 min per IP
  })
);
app.use(
  '/api/auth/verify',
  createRateLimitMiddleware<{ Bindings: Env; Variables: AuthVariables }>({
    limit: 10,
    windowSecs: 300, // 10 verify attempts per 5 min per IP
  })
);

// Middleware — allow CORS from local dev and Cloudflare Pages; optional CORS_ORIGINS env for production
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'https://dex-trading-agents.pages.dev',
];
app.use(
  '*',
  cors({
    origin: (reqOrigin, c) => {
      if (!reqOrigin) return reqOrigin;
      const allowed = [...defaultOrigins];
      const extra = c.env.CORS_ORIGINS?.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (extra?.length) allowed.push(...extra);
      return allowed.includes(reqOrigin) ? reqOrigin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-RateLimit-Remaining'],
    maxAge: 600,
    credentials: true,
  })
);

app.use('*', logger());

// Public routes (no auth required)
app.route('/api/health', healthRoute);
app.route('/api/pairs', pairsRoute);
app.route('/api/auth', authRoute);

// Auth middleware for protected routes
const authMiddleware = createAuthMiddleware();
app.use('/api/agents/*', authMiddleware as any);
app.use('/api/trades/*', authMiddleware as any);
app.use('/api/compare/*', authMiddleware as any);
app.use('/api/managers/*', authMiddleware as any);
app.use('/api/profiles/*', authMiddleware as any);

// Protected routes
app.route('/api/agents', agentsRoute);
app.route('/api/trades', tradesRoute);
app.route('/api/compare', comparisonRoute);
app.route('/api/managers', managersRoute);
app.route('/api/profiles', profilesRoute);

/** GET /api/models — list available LLM models from OpenRouter */
app.get('/api/models', async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({
      models: [
        { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nvidia Nemotron 120B Super (free)', context: 131072 },
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron Nano 30B (free)', context: 131072 },
        { id: 'openrouter/hunter-alpha', name: 'OpenRouter Hunter Alpha (free)', context: 1048576 },
        { id: 'stepfun/step-3.5-flash:free', name: 'Step 3.5 Flash (free)', context: 256000 },
        { id: 'arcee-ai/trinity-large-preview:free', name: 'Trinity Large Preview (free)', context: 65536 },
        { id: 'liquid/lfm-2.5-1.2b-thinking:free', name: 'LFM 2.5 1.2B Thinking (free)', context: 65536 },
        { id: 'liquid/lfm-2.5-1.2b-instruct:free', name: 'LFM 2.5 1.2B Instruct (free)', context: 65536 },
        { id: 'arcee-ai/trinity-mini:free', name: 'Trinity Mini (free)', context: 65536 },
        { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 Llama 405B (free)', context: 131072 },
        { id: 'qwen/qwen3-235b-a22b-thinking-2507:free', name: 'Qwen3 235B Thinking (free)', context: 131072 },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (free)', context: 131072 },
        { id: 'deepseek/deepseek-r1-0528:free', name: 'DeepSeek R1 (free)', context: 131072 },
        { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (free)', context: 131072 },
        { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', context: 131072 },
      ],
    });
  }
  try {
    const models = await listFreeModels(c.env.OPENROUTER_API_KEY, c.env.CACHE);
    return c.json({ models });
  } catch (err) {
    console.error('[models]', err);
    return c.json({ error: 'Failed to fetch models' }, 502);
  }
});

// Root catch-all
app.get('/', (c) =>
  c.json({
    name: 'Heppy Market API',
    version: '0.1.0',
    docs: '/api/health',
    routes: [
      'GET  /api/health',
      'GET  /api/models',
      'GET  /api/auth/nonce',
      'POST /api/auth/verify',
      'GET  /api/auth/me',
      'POST /api/auth/logout',
      'GET  /api/agents',
      'POST /api/agents',
      'GET  /api/agents/:id',
      'PATCH /api/agents/:id',
      'DELETE /api/agents/:id',
      'POST /api/agents/:id/start',
      'POST /api/agents/:id/stop',
      'POST /api/agents/:id/pause',
      'GET  /api/agents/:id/trades',
      'GET  /api/agents/:id/decisions',
      'GET  /api/agents/:id/performance',
      'GET  /api/trades',
      'GET  /api/trades/stats',
      'GET  /api/pairs/search?q=',
      'GET  /api/pairs/:chain/:address',
      'GET  /api/managers',
      'POST /api/managers',
      'GET  /api/managers/:id',
      'PATCH /api/managers/:id',
      'DELETE /api/managers/:id',
      'POST /api/managers/:id/start',
      'POST /api/managers/:id/stop',
      'POST /api/managers/:id/pause',
      'GET  /api/managers/:id/logs',
      'GET  /api/managers/:id/agents',
    ],
  })
);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

/** Get agentIds for a given interval from the global scheduler DO.
 *  Returns null if the scheduler is unavailable (triggers D1 fallback). */
async function getScheduledAgentIds(env: Env, interval: string): Promise<string[] | null> {
  try {
    const stub = env.AGENT_MANAGER.get(env.AGENT_MANAGER.idFromName('scheduler'));
    const res = await stub.fetch(
      new Request(`http://do/scheduler/agents?interval=${encodeURIComponent(interval)}`)
    );
    if (!res.ok) return null;
    const data = await res.json() as { agentIds: string[] };
    return data.agentIds;
  } catch {
    return null;
  }
}

// Cron trigger handler
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  const cron = event.cron;
  console.log(`[cron] Triggered: ${cron}`);

  if (!(await shouldRunCron(cron, env))) {
    return;
  }

  if (cron === '0 * * * *') {
    ctx.waitUntil(snapshotAllAgents(env));
    // Also run 1h agents (snapshot cron shares the same trigger)
  }

  const cronToInterval: Record<string, string> = {
    '*/15 * * * *': '15m',
    '0 * * * *': '1h',
    '0 */4 * * *': '4h',
    '0 0 * * *': '1d',
  };
  const targetInterval = cronToInterval[cron];
  if (!targetInterval) return;

  // Try scheduler DO first (avoids full D1 scan)
  const scheduledIds = await getScheduledAgentIds(env, targetInterval);

  let agentIds: string[];
  if (scheduledIds !== null) {
    agentIds = scheduledIds;
    console.log(`[cron] Scheduler DO returned ${agentIds.length} agents for interval=${targetInterval}`);
  } else {
    // Fallback: full D1 scan (ensures correctness even if scheduler state is stale)
    console.warn(`[cron] Scheduler DO unavailable — falling back to D1 scan for interval=${targetInterval}`);
    const db = (await import('drizzle-orm/d1')).drizzle(env.DB);
    const { agents } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    const runningAgents = await db.select({ id: agents.id, config: agents.config })
      .from(agents)
      .where(eq(agents.status, 'running'));
    agentIds = runningAgents
      .filter((agent) => {
        const config = JSON.parse(agent.config) as { analysisInterval?: string };
        const effectiveInterval =
          config.analysisInterval === '1m' || config.analysisInterval === '5m'
            ? '15m'
            : (config.analysisInterval ?? '1h');
        return effectiveInterval === targetInterval;
      })
      .map((a) => a.id);
  }

  for (const agentId of agentIds) {
    const doId = env.TRADING_AGENT.idFromName(agentId);
    const stub = env.TRADING_AGENT.get(doId);

    ctx.waitUntil(
      stub
        .fetch(
          new Request('http://do/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
          })
        )
        .catch((e) => console.warn(`[cron] Failed to trigger analysis for agent ${agentId}:`, e))
    );
  }
};

/**
 * Handle WebSocket upgrade requests for /api/agents/:id/ws.
 * These bypass Hono (which doesn't handle WS upgrades) and go straight to the DO.
 *
 * Auth flow: validate session cookie → verify agent ownership → proxy to DO.
 * The DO calls ctx.acceptWebSocket() (hibernatable) and returns a 101.
 */
async function handleAgentWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/ws$/);
  const agentId = match?.[1];
  if (!agentId) return new Response('Not Found', { status: 404 });

  // Validate session — session cookie sent automatically by browsers for same-origin WS
  const cookieHeader = request.headers.get('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return new Response('Unauthorized', { status: 401 });
  const session = await getSession(env.CACHE, token).catch(() => null);
  if (!session) return new Response('Unauthorized', { status: 401 });

  // Verify agent ownership before proxying to DO
  try {
    const { drizzle } = await import('drizzle-orm/d1');
    const { agents } = await import('./db/schema.js');
    const { eq, or, isNull } = await import('drizzle-orm');
    const db = drizzle(env.DB);
    const [agent] = await db
      .select({ ownerAddress: agents.ownerAddress })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) return new Response('Agent Not Found', { status: 404 });
    if (agent.ownerAddress && agent.ownerAddress.toLowerCase() !== session.walletAddress.toLowerCase()) {
      return new Response('Forbidden', { status: 403 });
    }
  } catch (err) {
    console.error('[ws] ownership check failed:', err);
    return new Response('Internal Error', { status: 500 });
  }

  // Proxy the WebSocket upgrade to the TradingAgentDO — it accepts the WS
  const doId = env.TRADING_AGENT.idFromName(agentId);
  const stub = env.TRADING_AGENT.get(doId);
  // Rewrite the path to /ws so the DO's fetch handler recognises it
  const doRequest = new Request(
    `http://do/ws`,
    {
      method: request.method,
      headers: request.headers,
    }
  );
  return stub.fetch(doRequest);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

    // WebSocket upgrades bypass Hono — handle before the router
    if (
      request.headers.get('Upgrade') === 'websocket' &&
      new URL(request.url).pathname.match(/^\/api\/agents\/[^/]+\/ws$/)
    ) {
      return handleAgentWebSocket(request, env);
    }
    return app.fetch(request, env, ctx);
  },
  scheduled,
  /** Cloudflare Queues consumer for async LLM processing. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === 'llm-jobs') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handleLlmQueueBatch(batch as any, env);
    }
  },
};

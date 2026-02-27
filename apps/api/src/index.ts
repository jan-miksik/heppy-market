import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types/env.js';
import type { AuthVariables } from './lib/auth.js';
import { createAuthMiddleware } from './lib/auth.js';
import healthRoute from './routes/health.js';
import pairsRoute from './routes/pairs.js';
import agentsRoute from './routes/agents.js';
import tradesRoute from './routes/trades.js';
import authRoute from './routes/auth.js';
import { snapshotAllAgents } from './services/snapshot.js';
import { listFreeModels } from './services/llm-router.js';
import comparisonRoute from './routes/comparison.js';
import managersRoute from './routes/managers.js';
import profilesRoute from './routes/profiles.js';

// Export Durable Object class (required for Workers runtime to register it)
export { TradingAgentDO } from './agents/trading-agent.js';
export { AgentManagerDO } from './agents/agent-manager.js';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

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
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron Nano 30B (free)', context: 131072 },
        { id: 'stepfun/step-3.5-flash:free', name: 'Step 3.5 Flash (free)', context: 65536 },
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

// Cron trigger handler
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  const cron = event.cron;
  console.log(`[cron] Triggered: ${cron}`);

  if (cron === '0 * * * *') {
    ctx.waitUntil(snapshotAllAgents(env));
    return;
  }

  const db = (await import('drizzle-orm/d1')).drizzle(env.DB);
  const { agents } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');

  const runningAgents = await db.select().from(agents).where(eq(agents.status, 'running'));

  const cronToInterval: Record<string, string> = {
    '*/5 * * * *': '5m',
    '*/15 * * * *': '15m',
    '0 * * * *': '1h',
    '0 */4 * * *': '4h',
    '0 0 * * *': '1d',
  };
  const targetInterval = cronToInterval[cron];
  if (!targetInterval) return;

  for (const agent of runningAgents) {
    const config = JSON.parse(agent.config) as {
      analysisInterval: string;
      paperBalance: number;
      slippageSimulation: number;
    };
    const intervalMatches =
      config.analysisInterval === targetInterval ||
      (targetInterval === '5m' && config.analysisInterval === '1m');
    if (!intervalMatches) continue;

    const doId = env.TRADING_AGENT.idFromName(agent.id);
    const stub = env.TRADING_AGENT.get(doId);

    ctx.waitUntil(
      stub
        .fetch(
          new Request('http://do/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: agent.id,
              paperBalance: config.paperBalance,
              slippageSimulation: config.slippageSimulation,
            }),
          })
        )
        .catch((e) => console.warn(`[cron] Failed to trigger analysis for agent ${agent.id}:`, e))
    );
  }
};

export default {
  fetch: app.fetch,
  scheduled,
};

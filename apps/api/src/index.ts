import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types/env.js';
import healthRoute from './routes/health.js';
import pairsRoute from './routes/pairs.js';
import agentsRoute from './routes/agents.js';
import tradesRoute from './routes/trades.js';
import { snapshotAllAgents } from './services/snapshot.js';
import { listFreeModels } from './services/llm-router.js';
import comparisonRoute from './routes/comparison.js';

// Export Durable Object class (required for Workers runtime to register it)
export { TradingAgentDO } from './agents/trading-agent.js';

const app = new Hono<{ Bindings: Env }>();

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
      const allowed = [...defaultOrigins];
      const extra = c.env.CORS_ORIGINS?.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (extra?.length) allowed.push(...extra);
      return allowed.includes(reqOrigin) ? reqOrigin : undefined;
    },
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-RateLimit-Remaining'],
    maxAge: 600,
    credentials: true,
  })
);

app.use('*', logger());

// Routes
app.route('/api/health', healthRoute);
app.route('/api/pairs', pairsRoute);
app.route('/api/agents', agentsRoute);
app.route('/api/trades', tradesRoute);
app.route('/api/compare', comparisonRoute);

/** GET /api/models — list available LLM models from OpenRouter */
app.get('/api/models', async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({
      models: [
        { id: 'deepseek/deepseek-r1-0528:free', name: 'DeepSeek R1 0528 (free)', context: 65536 },
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron Nano 30B (free)', context: 131072 },
        { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen 2.5 72B (free)', context: 32768 },
        { id: 'google/gemma-3-27b-it:free', name: 'Google Gemma 3 27B (free)', context: 131072 },
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
      'GET /api/health',
      'GET /api/models',
      'GET /api/agents',
      'POST /api/agents',
      'GET /api/agents/:id',
      'PATCH /api/agents/:id',
      'DELETE /api/agents/:id',
      'POST /api/agents/:id/start',
      'POST /api/agents/:id/stop',
      'POST /api/agents/:id/pause',
      'GET /api/agents/:id/trades',
      'GET /api/agents/:id/decisions',
      'GET /api/agents/:id/performance',
      'GET /api/trades',
      'GET /api/trades/stats',
      'GET /api/pairs/search?q=',
      'GET /api/pairs/:chain/:address',
    ],
  })
);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Cron trigger handler
// Cron schedule: */1, */5, */15, 0 *, 0 */4, 0 0 daily
const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  event,
  env,
  ctx
) => {
  const cron = event.cron;
  console.log(`[cron] Triggered: ${cron}`);

  // Hourly (0 * * * *): take performance snapshots for all agents
  if (cron === '0 * * * *') {
    ctx.waitUntil(snapshotAllAgents(env));
    return;
  }

  // All crons: wake running agents that match this interval
  // Each DO manages its own alarm, so cron triggers here are a fallback
  // to re-wake any DOs that may have lost their alarm
  const db = (await import('drizzle-orm/d1')).drizzle(env.DB);
  const { agents } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');

  const runningAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.status, 'running'));

  const cronToInterval: Record<string, string> = {
    '*/1 * * * *': '1m',
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
    if (config.analysisInterval !== targetInterval) continue;

    const doId = env.TRADING_AGENT.idFromName(agent.id);
    const stub = env.TRADING_AGENT.get(doId);

    // Trigger analysis directly via POST /analyze (also re-initializes DO if alarm was lost)
    ctx.waitUntil(
      stub.fetch(
        new Request('http://do/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: agent.id,
            paperBalance: config.paperBalance,
            slippageSimulation: config.slippageSimulation,
          }),
        })
      ).catch((e) =>
        console.warn(`[cron] Failed to trigger analysis for agent ${agent.id}:`, e)
      )
    );
  }
};

export default {
  fetch: app.fetch,
  scheduled,
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './types/env.js';
import healthRoute from './routes/health.js';
import pairsRoute from './routes/pairs.js';
import agentsRoute from './routes/agents.js';
import tradesRoute from './routes/trades.js';

// Export Durable Object class (required for Workers runtime to register it)
export { TradingAgentDO } from './agents/trading-agent.js';

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use(
  '*',
  cors({
    origin: ['http://localhost:3000', 'https://dex-trading-agents.pages.dev'],
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
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

// Root catch-all
app.get('/', (c) =>
  c.json({
    name: 'DEX Trading Agents API',
    version: '0.1.0',
    docs: '/api/health',
  })
);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Cron trigger handler
const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  _event,
  _env,
  _ctx
) => {
  // Phase 4: wake agents matching this cron schedule
  console.log('Cron triggered');
};

export default {
  fetch: app.fetch,
  scheduled,
};

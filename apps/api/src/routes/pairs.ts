import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types/env.js';
import {
  createDexDataService,
  filterBaseChainPairs,
} from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import { validateQuery } from '../lib/validation.js';
import { ValidationError } from '../lib/validation.js';

const pairs = new Hono<{ Bindings: Env }>();

/**
 * GET /api/pairs/gecko-search?q=WETH+USDC
 * Diagnostic: test GeckoTerminal directly and show raw results.
 */
pairs.get('/gecko-search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q param required' }, 400);
  const svc = createGeckoTerminalService(c.env.CACHE);
  try {
    const pools = await svc.searchPools(q);
    return c.json({ query: q, count: pools.length, pools });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

/** GET /api/pairs/search?q=WETH+USDC */
pairs.get('/search', async (c) => {
  const query = validateQuery(c, z.object({ q: z.string().min(1) }));
  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.searchPairs(query.q);
  const basePairs = filterBaseChainPairs(results);

  return c.json({
    query: query.q,
    count: basePairs.length,
    pairs: basePairs,
  });
});

/** GET /api/pairs/top?chain=base — top pairs by 24h volume, cached 5min */
pairs.get('/top', async (c) => {
  const query = validateQuery(
    c,
    z.object({ chain: z.enum(['base']).default('base') })
  );
  const svc = createDexDataService(c.env.CACHE);
  const topPairs = await svc.getTopPairsForChain(query.chain);
  return c.json({
    pairs: topPairs,
    updatedAt: new Date().toISOString(),
  });
});

/** GET /api/pairs/:chain/:address */
pairs.get('/:chain/:address', async (c) => {
  const chain = c.req.param('chain');
  const address = c.req.param('address');

  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.getPairsByChain(chain, address);

  if (results.length === 0) {
    return c.json({ error: 'Pair not found' }, 404);
  }

  return c.json({ pair: results[0], allResults: results });
});

/** GET /api/pairs/token/:address */
pairs.get('/token/:address', async (c) => {
  const address = c.req.param('address');
  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.getTokenPairs(address);
  const basePairs = filterBaseChainPairs(results);

  return c.json({ count: basePairs.length, pairs: basePairs });
});

// Error handler for this router
pairs.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, fieldErrors: err.fieldErrors }, 400);
  }
  console.error('[pairs route]', err);
  return c.json({ error: 'Failed to fetch pair data' }, 502);
});

export default pairs;

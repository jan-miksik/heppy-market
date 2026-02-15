import { Hono } from 'hono';
import type { Env } from '../types/env.js';

const health = new Hono<{ Bindings: Env }>();

health.get('/', async (c) => {
  // Verify D1 is accessible
  let dbStatus = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').run();
  } catch (err) {
    dbStatus = `error: ${String(err)}`;
  }

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    services: {
      db: dbStatus,
      cache: 'ok',
    },
  });
});

export default health;

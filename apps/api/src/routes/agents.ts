import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { ValidationError } from '../lib/validation.js';
import { registerAgentCoreRoutes } from './agents-route/core.js';
import { registerAgentHistoryRoutes } from './agents-route/history.js';
import { registerAgentInitiaRoutes } from './agents-route/initia.js';
import { registerAgentLifecycleRoutes } from './agents-route/lifecycle.js';
import { registerAgentPersonaRoutes } from './agents-route/persona.js';
import { registerAgentSelfModificationRoutes } from './agents-route/self-modifications.js';

const agentsRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

registerAgentCoreRoutes(agentsRoute);
registerAgentInitiaRoutes(agentsRoute);
registerAgentLifecycleRoutes(agentsRoute);
registerAgentHistoryRoutes(agentsRoute);
registerAgentPersonaRoutes(agentsRoute);
registerAgentSelfModificationRoutes(agentsRoute);

// Error handler
agentsRoute.onError((err, c) => {
  if (err instanceof ValidationError) {
    console.error('[agents route] ValidationError', {
      path: c.req.path,
      method: c.req.method,
      fieldErrors: err.fieldErrors ?? null,
    });
    return c.json({ error: err.message, fieldErrors: err.fieldErrors }, 400);
  }
  console.error('[agents route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default agentsRoute;

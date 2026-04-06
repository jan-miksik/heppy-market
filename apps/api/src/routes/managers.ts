import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { registerManagerCoreRoutes } from './managers-route/core.js';
import { registerManagerInsightRoutes } from './managers-route/insights.js';
import { registerManagerLifecycleRoutes } from './managers-route/lifecycle.js';
import { registerManagerPersonaRoutes } from './managers-route/persona.js';
import { safeParseManagerLogResult } from './managers-route/shared.js';

const managersRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

registerManagerCoreRoutes(managersRoute);
registerManagerLifecycleRoutes(managersRoute);
registerManagerInsightRoutes(managersRoute);
registerManagerPersonaRoutes(managersRoute);

export { safeParseManagerLogResult };
export default managersRoute;

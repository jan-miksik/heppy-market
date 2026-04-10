# API Routes

- `agents-route/*`: agent-specific route handlers.
- `managers-route/*`: manager-specific route handlers.
- `_shared/*`: shared ownership, stored-JSON, and response helpers reused across routes.
- `agents.ts`, `managers.ts`: route composition/registration.

Keep route handlers thin: request parsing + permission checks + call into service/helper layers.

type JsonContext = { json: (body: unknown, init?: number | ResponseInit) => Response };

export function jsonError(
  c: JsonContext,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.json({ error, ...extra }, { status });
}

export function badRequestJson(
  c: JsonContext,
  error = 'Bad Request',
  extra: Record<string, unknown> = {},
): Response {
  return jsonError(c, 400, error, extra);
}

export function unauthorizedJson(c: JsonContext, error = 'Unauthorized'): Response {
  return jsonError(c, 401, error);
}

export function forbiddenJson(c: JsonContext, error = 'Forbidden'): Response {
  return jsonError(c, 403, error);
}

export function notFoundJson(c: JsonContext, entity = 'Resource'): Response {
  return jsonError(c, 404, `${entity} not found`);
}

export function upstreamFailureJson(c: JsonContext, error: string, extra: Record<string, unknown> = {}): Response {
  return jsonError(c, 502, error, extra);
}

export function internalServerErrorJson(c: JsonContext, error = 'Internal server error'): Response {
  return jsonError(c, 500, error);
}

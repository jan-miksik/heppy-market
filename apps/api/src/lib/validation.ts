import { z } from 'zod';
import type { Context } from 'hono';

/** Convert Zod flattened field errors to Record<string, string[]> (filter undefined) */
function toFieldErrors(
  raw: Record<string, string[] | undefined>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.length > 0) result[k] = v;
  }
  return result;
}

/** Validate request body with a Zod schema, returning parsed data or throwing HTTP 400 */
export async function validateBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T
): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'Validation failed',
      toFieldErrors(result.error.flatten().fieldErrors)
    );
  }
  return result.data;
}

/** Validate query params with a Zod schema */
export function validateQuery<T extends z.ZodTypeAny>(
  c: Context,
  schema: T
): z.output<T> {
  const params = Object.fromEntries(
    Object.entries(c.req.query()).map(([k, v]) => [k, v])
  );
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError(
      'Invalid query parameters',
      toFieldErrors(result.error.flatten().fieldErrors)
    );
  }
  return result.data;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

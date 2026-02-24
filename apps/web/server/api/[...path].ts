/**
 * API proxy: forwards /api/* to the backend Worker via Cloudflare Service Binding.
 * When the API binding is present (production on Pages), requests stay internal.
 * When absent (local dev), falls back to the configured apiBase URL.
 */
import { getRequestURL, getRequestHeaders, readRawBody, setResponseStatus, setResponseHeaders } from 'h3';

/** Service binding: fetch(request) → response (Worker is not exposed publicly). */
interface CloudflareEnv {
  API?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

/** Forward a fetch Response back through h3 properly. */
async function proxyResponse(event: Parameters<typeof defineEventHandler>[0] extends (e: infer E) => unknown ? E : never, res: Response) {
  setResponseStatus(event, res.status, res.statusText);

  // Forward response headers
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    // Skip headers that h3/nitro manages itself
    if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  setResponseHeaders(event, headers);

  // Return the body as text so h3 can handle encoding
  return res.text();
}

export default defineEventHandler(async (event) => {
  // event.path may or may not include /api prefix and may include query string.
  // Strip query from path (we extract it separately) and ensure /api prefix.
  const rawPath = event.path.split('?')[0];
  const pathname = rawPath.startsWith('/api') ? rawPath : `/api${rawPath}`;
  const url = getRequestURL(event);
  const query = url.search || '';

  // Cloudflare Pages: env is available on context when deployed with service binding
  const cfEnv = (event.context as { cloudflare?: { env?: CloudflareEnv } })?.cloudflare?.env;
  const api = cfEnv?.API;

  const method = event.method;
  const headers = getRequestHeaders(event);
  const body = method !== 'GET' && method !== 'HEAD' ? await readRawBody(event) : undefined;

  if (api) {
    const workerUrl = `https://internal${pathname}${query}`;
    const response = await api.fetch(workerUrl, {
      method,
      headers: new Headers(headers as Record<string, string>),
      body: body ?? undefined,
    });
    return proxyResponse(event, response);
  }

  // Local dev: no binding — proxy to the configured upstream (e.g. http://localhost:8787)
  const config = useRuntimeConfig();
  const base = (config.apiUpstream as string)?.replace(/\/$/, '') || 'http://localhost:8787';
  const target = `${base}${pathname}${query}`;
  const reqHeaders = new Headers(headers as Record<string, string>);
  reqHeaders.delete('host');

  try {
    const res = await fetch(target, { method, headers: reqHeaders, body: body ?? undefined, signal: AbortSignal.timeout(200_000) });
    return proxyResponse(event, res);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; statusMessage?: string; message?: string };
    throw createError({
      statusCode: e.statusCode ?? 502,
      statusMessage: e.statusMessage ?? 'Bad Gateway',
      message: e.message ?? 'API unavailable',
    });
  }
});

/**
 * API proxy: forwards /api/* to the backend Worker via Cloudflare Service Binding.
 * When the API binding is present (production on Pages), requests stay internal.
 * When absent (local dev), falls back to the configured apiBase URL.
 */
import { getRequestURL, getRequestHeaders, readRawBody } from 'h3';

/** Service binding: fetch(request) → response (Worker is not exposed publicly). */
interface CloudflareEnv {
  API?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

export default defineEventHandler(async (event) => {
  const path = event.path.startsWith('/api') ? event.path : `/api${event.path}`;
  const url = getRequestURL(event);
  const query = url.search || '';

  // Cloudflare Pages: env is available on context when deployed with service binding
  const cfEnv = (event.context as { cloudflare?: { env?: CloudflareEnv } })?.cloudflare?.env;
  const api = cfEnv?.API;

  if (api) {
    const workerUrl = `https://internal${path}${query}`;
    const method = event.method;
    const headers = getRequestHeaders(event);
    const body = method !== 'GET' && method !== 'HEAD' ? await readRawBody(event) : undefined;

    const response = await api.fetch(workerUrl, {
      method,
      headers: new Headers(headers as Record<string, string>),
      body: body ?? undefined,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Local dev: no binding — proxy to the configured upstream (e.g. http://localhost:8787)
  const config = useRuntimeConfig();
  const base = (config.apiUpstream as string)?.replace(/\/$/, '') || 'http://localhost:8787';
  const target = `${base}${path}${query}`;
  const method = event.method;
  const headers = new Headers(getRequestHeaders(event) as Record<string, string>);
  headers.delete('host');
  const body = method !== 'GET' && method !== 'HEAD' ? await readRawBody(event) : undefined;

  try {
    const res = await fetch(target, { method, headers, body: body ?? undefined });
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; statusMessage?: string; message?: string };
    throw createError({
      statusCode: e.statusCode ?? 502,
      statusMessage: e.statusMessage ?? 'Bad Gateway',
      message: e.message ?? 'API unavailable',
    });
  }
});

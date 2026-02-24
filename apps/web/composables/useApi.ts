/**
 * Base API composable — wraps $fetch with the configured API base URL.
 * Includes timeout, error extraction, and console logging for failed requests.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Extract a human-readable error message from a $fetch error. */
export function extractApiError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);

  const e = err as {
    statusCode?: number;
    status?: number;
    statusMessage?: string;
    data?: { error?: string; message?: string };
    message?: string;
  };

  // Prefer the API's error body
  const body = e.data?.error || e.data?.message;
  if (body) return body;

  // Fetch/network errors
  if (e.statusCode === 502 || e.status === 502) return 'API server is unavailable';
  if (e.message?.includes('fetch failed') || e.message?.includes('ECONNREFUSED')) {
    return 'Cannot reach the API server';
  }
  if (e.message?.includes('timeout') || e.message?.includes('aborted')) {
    return 'Request timed out — the server may be down';
  }

  return e.statusMessage || e.message || 'An unexpected error occurred';
}

export function useApi() {
  const config = useRuntimeConfig();
  const base = config.public.apiBase as string;

  async function request<T>(
    path: string,
    options?: Record<string, unknown>
  ): Promise<T> {
    const method = (options?.method as string) ?? 'GET';
    try {
      const res = await $fetch<T>(`${base}${path}`, {
        ...options,
        timeout: (options?.timeout as number) ?? DEFAULT_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          ...((options?.headers as Record<string, string>) ?? {}),
        },
      } as Parameters<typeof $fetch>[1]);
      return res as T;
    } catch (err) {
      console.error(`[api] ${method} ${path} failed:`, err);
      throw err;
    }
  }

  return { request, base };
}

/**
 * Base API composable — wraps $fetch with the configured API base URL.
 */
export function useApi() {
  const config = useRuntimeConfig();
  const base = config.public.apiBase as string;

  async function request<T>(
    path: string,
    options?: Parameters<typeof $fetch>[1]
  ): Promise<T> {
    return $fetch<T>(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
  }

  return { request, base };
}

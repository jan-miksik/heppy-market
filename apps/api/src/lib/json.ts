export function parseJsonRequired<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function parseJsonOr<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonOrNull<T>(raw: string): T | null {
  return parseJsonOr<T | null>(raw, null);
}

export function parseJsonObjectOrEmpty(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = parseJsonOr<unknown>(raw, null);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

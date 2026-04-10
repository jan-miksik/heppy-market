import { parseJsonObjectOrEmpty, parseJsonOr, parseJsonOrNull, parseJsonRequired } from '../../lib/json.js';

export function parseStoredJson<T>(raw: string): T {
  return parseJsonRequired<T>(raw);
}

export function parseStoredJsonOr<T>(raw: string, fallback: T): T {
  return parseJsonOr<T>(raw, fallback);
}

export function parseStoredJsonOrNull<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  return parseJsonOrNull<T>(raw);
}

export function parseStoredJsonObject(raw: string | null | undefined): Record<string, unknown> {
  return parseJsonObjectOrEmpty(raw);
}

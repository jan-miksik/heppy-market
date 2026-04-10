type StringKeyOf<T> = Extract<{
  [K in keyof T]: T[K] extends string | null | undefined ? K : never
}[keyof T], keyof T>;

export function formatStoredEntity<T extends Record<string, unknown>>(
  row: T,
  parsers: Partial<Record<StringKeyOf<T>, (raw: string) => unknown>>,
): T & Record<string, unknown> {
  const formatted: Record<string, unknown> = { ...row };

  for (const [key, parser] of Object.entries(parsers) as Array<[string, ((raw: string) => unknown) | undefined]>) {
    if (!parser) continue;
    const raw = row[key as keyof T];
    if (typeof raw !== 'string') continue;
    formatted[key] = parser(raw);
  }

  return formatted as T & Record<string, unknown>;
}

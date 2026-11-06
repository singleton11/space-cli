/**
 * Small defensive JSON-traversal helpers shared by the API parsers.
 * Every Space response field is treated as untrusted: wrong shapes become
 * `null` (or empty arrays) instead of exceptions, and the parsers layer
 * explicit `protocol-error`s on top where shape matters.
 */
export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function prop(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNonEmpty(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function assertNonNull<T>(v: T | null | undefined, msg: string): T {
  if (v == null) throw new Error(msg);
  return v;
}

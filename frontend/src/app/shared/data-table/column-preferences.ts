/** Only presentation preferences are stored; rows and product data remain server owned. */
export function readColumns(key: string, allowed: readonly string[], defaults: string[]): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      Array.isArray(value) &&
      value.every((item: unknown) => typeof item === 'string' && allowed.includes(item))
    ) {
      return Array.from(new Set<string>(value));
    }
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
  return defaults;
}

export function saveColumns(key: string, columns: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(columns));
  } catch {
    // The current view remains usable without persistence.
  }
}

/** Date filters use the browser's local calendar and an exclusive upper boundary. */
export function calendarBoundary(value: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || calendarDate(date.toISOString(), false) !== value)
    return null;
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function calendarDate(boundary: string, end: boolean): string {
  if (!boundary) return '';
  const date = new Date(boundary);
  if (!Number.isFinite(date.getTime())) return '';
  if (end) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

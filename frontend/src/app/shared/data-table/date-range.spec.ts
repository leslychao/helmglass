import { describe, expect, it } from 'vitest';
import { calendarBoundary, calendarDate } from './date-range';

describe('calendar range', () => {
  it('retains the selected local day and makes its upper boundary exclusive', () => {
    const start = calendarBoundary('2026-10-03', false);
    const end = calendarBoundary('2026-10-03', true);
    expect(calendarDate(start ?? '', false)).toBe('2026-10-03');
    expect(calendarDate(end ?? '', true)).toBe('2026-10-03');
    expect(new Date(end ?? '').getDate()).toBe(4);
    expect(new Date(end ?? '').getHours()).toBe(0);
  });

  it('clears absent or invalid dates', () => {
    expect(calendarBoundary('', false)).toBeNull();
    expect(calendarBoundary('invalid', true)).toBeNull();
    expect(calendarBoundary('2026-02-30', false)).toBeNull();
    expect(calendarBoundary('2026-02-29', true)).toBeNull();
    expect(calendarBoundary('2024-02-29', false)).not.toBeNull();
    expect(calendarDate('invalid', false)).toBe('');
  });
});

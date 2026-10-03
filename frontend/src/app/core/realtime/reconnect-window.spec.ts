import { describe, expect, it } from 'vitest';
import { ReconnectWindow } from './reconnect-window';

describe('viewer reconnect deadline', () => {
  it('bounds automatic recovery to two minutes and respects Retry-After', () => {
    const window = new ReconnectWindow();
    expect(window.nextDelay(0, 0, 0)).toBe(1000);
    expect(window.nextDelay(1000, 10000, 0.5)).toBe(10000);
    expect(window.nextDelay(119000)).toBeNull();
    expect(window.nextDelay(120000)).toBeNull();
    window.reset();
    expect(window.nextDelay(130000, 0, 0.5)).toBe(1000);
  });

  it('does not schedule beyond the recovery deadline for a long server delay', () => {
    expect(new ReconnectWindow().nextDelay(0, 180000)).toBeNull();
  });
});

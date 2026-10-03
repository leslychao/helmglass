import { describe, it, expect } from 'vitest';
import { committedTextActions, pointerAction } from './input-action';

describe('remote input coordinates and wire contract', () => {
  const rectangle = { left: 100, top: 50, width: 640, height: 360 };
  const viewport = { width: 1280, height: 720 };

  it('keeps a pasted supplementary character intact across bounded text messages', () => {
    const prefix = 'a'.repeat(16383);
    expect([...committedTextActions(prefix + '😀b')]).toEqual([
      { type: 'committedText', text: prefix },
      { type: 'committedText', text: '😀b' },
    ]);
    expect([...committedTextActions('')]).toEqual([]);
  });

  it('maps a resized viewport and sends no pointer button on moves', () => {
    expect(
      pointerAction('pointerMove', { clientX: 420, clientY: 230, button: -1 }, rectangle, viewport),
    ).toEqual({ type: 'pointerMove', x: 640, y: 360 });
  });
  it('uses the named button required by the worker and bounds pointer capture outside the panel', () => {
    expect(
      pointerAction('pointerUp', { clientX: 900, clientY: 0, button: 2 }, rectangle, viewport),
    ).toEqual({ type: 'pointerUp', x: 1279, y: 0, button: 'RIGHT' });
  });
  it('does not send coordinates for a hidden viewport or unsupported mouse button', () => {
    expect(
      pointerAction(
        'pointerMove',
        { clientX: 0, clientY: 0, button: 0 },
        { ...rectangle, width: 0 },
        viewport,
      ),
    ).toBeNull();
    expect(
      pointerAction('pointerDown', { clientX: 120, clientY: 60, button: 4 }, rectangle, viewport),
    ).toBeNull();
  });
});

export type InputAction =
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'pointerDown' | 'pointerUp'; button: 'LEFT' | 'MIDDLE' | 'RIGHT'; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'keyDown' | 'keyUp'; key: string }
  | { type: 'committedText'; text: string }
  | { type: 'heartbeat' };

/** Preserve UTF-16 surrogate pairs at the worker's text message size boundary. */
export function* committedTextActions(text: string): Generator<InputAction> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 16384);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield { type: 'committedText', text: text.slice(offset, end) };
    offset = end;
  }
}

/** Coordinates stay in the remote viewport when the panel is resized or letterboxed. */
export function pointerAction(
  type: 'pointerMove' | 'pointerDown' | 'pointerUp',
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'button'>,
  rectangle: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewport: { width: number; height: number },
): InputAction | null {
  if (rectangle.width <= 0 || rectangle.height <= 0) return null;
  const x = Math.max(
    0,
    Math.min(
      viewport.width - 1,
      Math.floor(((event.clientX - rectangle.left) / rectangle.width) * viewport.width),
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      viewport.height - 1,
      Math.floor(((event.clientY - rectangle.top) / rectangle.height) * viewport.height),
    ),
  );
  if (type === 'pointerMove') return { type, x, y };
  const button =
    event.button === 0
      ? 'LEFT'
      : event.button === 1
        ? 'MIDDLE'
        : event.button === 2
          ? 'RIGHT'
          : null;
  return button ? { type, button, x, y } : null;
}

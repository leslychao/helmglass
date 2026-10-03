import { paintMarker } from './marker.mjs';

const parameters = new URL(location.href).searchParams;
const run = Number(parameters.get('run'));
const inputDelayMs = Number(parameters.get('inputDelayMs') ?? 0);
if (!Number.isInteger(run) || run < 1 || run > 0xffffffff || !Number.isInteger(inputDelayMs)
  || inputDelayMs < 0 || inputDelayMs > 1000) throw new Error('Invalid controlled Page parameters');
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const input = document.querySelector('input');
canvas.width = innerWidth;
canvas.height = innerHeight;
let frame = 0;
let nonce = 0;
let pending = false;
input.addEventListener('input', () => {
  const text = input.value;
  input.value = '';
  if (pending || !/^[1-9][0-9]{0,9}$/.test(text)) return;
  const nextNonce = Number(text);
  if (nextNonce <= nonce || nextNonce > 0xffffffff) return;
  pending = true;
  setTimeout(() => { nonce = nextNonce; pending = false; }, inputDelayMs);
});
function draw(now) {
  context.fillStyle = '#18232c';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '16px sans-serif';
  context.fillStyle = '#fff';
  context.fillText('Real Chromium Page → captured pixels → H.264 → decoded visual marker', 24, 90);
  for (let index = 0; index < 24; index++) {
    context.fillStyle = `hsl(${(index * 15 + now / 40) % 360} 70% 55%)`;
    context.fillRect(index * canvas.width / 24, 150, canvas.width / 24, 100);
  }
  context.fillStyle = '#fff';
  context.font = '13px monospace';
  for (let line = 0; line < 12; line++) {
    context.fillText(`Readable line ${line}: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ`, 24, 300 + line * 18);
  }
  context.fillRect(500 + 150 * Math.sin(now / 300), 560, 48, 48);
  paintMarker(context, { run, frame: ++frame, nonce });
  requestAnimationFrame(draw);
}
input.focus();
requestAnimationFrame(draw);

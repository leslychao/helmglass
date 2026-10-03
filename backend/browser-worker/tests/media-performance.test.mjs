import assert from 'node:assert/strict';
import test from 'node:test';
import { MeasurementCollector } from './media-performance/collector.mjs';
import { MARKER, encodeMarker, decodeMarker, paintMarker, markerFromPixels } from './media-performance/marker.mjs';

const value = { run: 0x01020304, frame: 0x05060708, nonce: 0x090a0b0c };
const timing = (presentedFrames, expectedDisplayTime) => ({ presentedFrames, expectedDisplayTime });

test('marker has fixed byte order, bounded values and detects every single-bit corruption', () => {
  const bytes = encodeMarker(value);
  assert.equal(Buffer.from(bytes.subarray(0, 14)).toString('hex'), '48470102030405060708090a0b0c');
  assert.deepEqual(decodeMarker(bytes), value);
  for (let bit = 0; bit < 128; bit++) {
    const corrupt = bytes.slice();
    corrupt[bit >> 3] ^= 1 << (bit & 7);
    assert.equal(decodeMarker(corrupt), null, `corruption ${bit}`);
  }
  assert.equal(decodeMarker(bytes.subarray(0, 15)), null);
  for (const invalid of [-1, 0x100000000, NaN, 1.5]) {
    assert.throws(() => encodeMarker({ ...value, nonce: invalid }), RangeError);
  }
});

test('fixed marker ROI tolerates dark/light compression noise but rejects ambiguous cells', () => {
  const data = new Uint8ClampedArray(MARKER.width * MARKER.height * 4);
  const context = { fillStyle: '', fillRect(x, y, width, height) {
    const light = this.fillStyle === '#fff' ? 220 : 30;
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const index = (row * MARKER.width + column) * 4;
        data.set([light, light, light, 255], index);
      }
    }
  } };
  paintMarker(context, value);
  const pixels = { data, width: MARKER.width, height: MARKER.height };
  assert.deepEqual(markerFromPixels(pixels), value);
  context.fillStyle = '#fff';
  for (let y = 11; y <= 13; y++) {
    for (let x = 11; x <= 13; x++) data.fill(125, (y * MARKER.width + x) * 4, (y * MARKER.width + x) * 4 + 3);
  }
  assert.equal(markerFromPixels(pixels), null);
  assert.equal(markerFromPixels({ ...pixels, width: 1920 }), null);
});

test('only matching nonce pixels count as latency, not following frames or foreign markers', () => {
  const collector = new MeasurementCollector({ run: 1, startedAt: 0, durationMs: 10_000 });
  collector.beginInput(7, 100);
  collector.observe({ run: 1, frame: 1, nonce: 0 }, timing(1, 120), 121);
  collector.observe({ run: 2, frame: 2, nonce: 7 }, timing(2, 140), 141);
  collector.observe({ run: 1, frame: 3, nonce: 8 }, timing(3, 160), 161);
  assert.equal(collector.snapshot(170).matched, 0);
  collector.observe({ run: 1, frame: 4, nonce: 7 }, timing(4, 251), 260);
  const result = collector.snapshot(300);
  assert.equal(result.matched, 1);
  assert.equal(result.foreign, 1);
  assert.deepEqual(result.latencyMs, { min: 151, p50: 151, p95: 151, p99: 151, max: 151 });
  assert.deepEqual(result.observedLatencyMs, { min: 160, p50: 160, p95: 160, p99: 160, max: 160 });
  assert.equal(result.lateCallbacks, 1);
});

test('unique pixels, duplicate frames and missed callbacks remain distinct', () => {
  const collector = new MeasurementCollector({ run: 1, startedAt: 0, durationMs: 5000 });
  collector.observe({ run: 1, frame: 12, nonce: 0 }, timing(90, 10), 10);
  collector.observe({ run: 1, frame: 12, nonce: 0 }, timing(91, 20), 20);
  collector.observe(null, timing(95, 70), 70);
  collector.observe({ run: 1, frame: 15, nonce: 0 }, timing(96, 90), 90);
  const result = collector.snapshot(1000);
  assert.equal(result.unique, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.corrupt, 1);
  assert.equal(result.missedCallbacks, 3);
  assert.equal(result.presented, 7);
  assert.equal(result.observedUniqueFps, 2);
  assert.equal(result.compositorFps, 7);
  assert.equal(result.maxGapMs, 50);
});

test('timeouts, unfinished inputs and completed duration are explicit bounded outcomes', () => {
  const collector = new MeasurementCollector({ run: 1, startedAt: 0, durationMs: 4000 });
  collector.beginInput(1, 0);
  assert.throws(() => collector.beginInput(2, 1));
  collector.tick(3000);
  collector.beginInput(2, 3001);
  const result = collector.snapshot(4000);
  assert.equal(result.timedOut, 1);
  assert.equal(result.abandoned, 1);
  assert.equal(result.inputs, 2);
  assert.equal(result.matched, 0);
  assert.equal(result.unmatchedInputs, 2);
  assert.equal(result.reason, 'DURATION_COMPLETE');
  assert.equal(result.latencyMs.p95, null);
  assert.equal(collector.histogram.length, 3001);
  assert.equal(collector.seconds.length, 4);
  assert.throws(() => collector.beginInput(3, 4001));
  assert.throws(() => new MeasurementCollector({ run: 1, startedAt: 0, durationMs: 600001 }));
});

test('old visual or compositor generation stops rather than combining peer statistics', () => {
  for (const [frame, presented, expected] of [[1, 3, 'VISUAL_COUNTER_RESET'], [3, 1, 'FRAME_COUNTER_RESET']]) {
    const collector = new MeasurementCollector({ run: 1, startedAt: 0 });
    collector.observe({ run: 1, frame: 2, nonce: 0 }, timing(2, 10), 10);
    collector.observe({ run: 1, frame, nonce: 0 }, timing(presented, 20), 20);
    assert.equal(collector.snapshot(100).reason, expected);
    assert.equal(collector.snapshot(100).unique, 1);
  }
});

test('a late observer preserves run deadline chronology and rejects invalid clock values', () => {
  const collector = new MeasurementCollector({ run: 1, startedAt: 0, durationMs: 1000 });
  collector.beginInput(1, 100);
  const result = collector.snapshot(10_000);
  assert.equal(result.elapsedMs, 1000);
  assert.equal(result.timedOut, 0);
  assert.equal(result.abandoned, 1);
  assert.throws(() => collector.tick(NaN), RangeError);
});

test('stopping fences late callback/input and percentiles use all successful samples', () => {
  const collector = new MeasurementCollector({ run: 1, startedAt: 0 });
  for (let index = 1; index <= 100; index++) {
    collector.beginInput(index, index * 200);
    collector.observe({ run: 1, frame: index, nonce: index }, timing(index, index * 201), index * 201);
  }
  collector.stop(21000, 'PEER_REPLACED');
  collector.observe({ run: 1, frame: 101, nonce: 100 }, timing(101, 22000), 22000);
  const result = collector.snapshot(23000);
  assert.equal(result.matched, 100);
  assert.equal(result.unique, 100);
  assert.deepEqual(result.latencyMs, { min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(result.elapsedMs, 21000);
  assert.throws(() => collector.beginInput(101, 23000));
});

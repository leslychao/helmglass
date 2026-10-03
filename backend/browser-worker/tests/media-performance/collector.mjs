import { MARKER, markerFromPixels } from './marker.mjs';

const MAX_DURATION_MS = 600_000;
const INPUT_TIMEOUT_MS = 3000;

/** Fixed memory: one pending input, two 3001-bin histograms, at most 600 fps bins. */
export class MeasurementCollector {
  constructor({ run, startedAt, durationMs = MAX_DURATION_MS }) {
    if (!Number.isInteger(run) || run < 1 || run > 0xffffffff || !Number.isFinite(startedAt)
      || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS) {
      throw new RangeError('Invalid measurement run');
    }
    this.run = run;
    this.startedAt = startedAt;
    this.deadline = startedAt + durationMs;
    this.histogram = new Uint32Array(INPUT_TIMEOUT_MS + 1);
    this.observedHistogram = new Uint32Array(INPUT_TIMEOUT_MS + 1);
    this.seconds = new Uint32Array(Math.ceil(durationMs / 1000));
    this.counts = { callbacks: 0, presented: 0, missedCallbacks: 0, unique: 0, duplicates: 0,
      corrupt: 0, foreign: 0, lateCallbacks: 0, inputs: 0, matched: 0, timedOut: 0, abandoned: 0 };
    this.lastNonce = 0;
    this.maxGapMs = 0;
  }

  tick(now) {
    if (!Number.isFinite(now)) throw new RangeError('Invalid measurement time');
    if (this.endedAt !== undefined) return;
    if (this.pending && Math.min(now, this.deadline) >= this.pending.at + INPUT_TIMEOUT_MS) {
      this.counts.timedOut++;
      this.pending = undefined;
    }
    if (now >= this.deadline) this.stop(this.deadline, 'DURATION_COMPLETE');
  }

  beginInput(nonce, at) {
    this.tick(at);
    if (this.endedAt !== undefined || this.pending || !Number.isFinite(at) || at < this.startedAt
      || !Number.isInteger(nonce) || nonce <= this.lastNonce || nonce > 0xffffffff) {
      throw new Error('Input probe unavailable');
    }
    this.lastNonce = nonce;
    this.pending = { nonce, at };
    this.counts.inputs++;
  }

  observe(marker, metadata, now) {
    this.tick(now);
    if (this.endedAt !== undefined) return;
    const { presentedFrames, expectedDisplayTime } = metadata;
    if (!Number.isInteger(presentedFrames) || presentedFrames < 1 || !Number.isFinite(expectedDisplayTime)
      || !Number.isFinite(now) || now < this.startedAt) throw new Error('Invalid frame timing');
    if (this.lastPresented !== undefined && presentedFrames <= this.lastPresented) {
      this.stop(now, 'FRAME_COUNTER_RESET');
      return;
    }
    const delta = this.lastPresented === undefined ? 1 : presentedFrames - this.lastPresented;
    this.lastPresented = presentedFrames;
    this.counts.callbacks++;
    this.counts.presented += delta;
    this.counts.missedCallbacks += delta - 1;
    if (now > expectedDisplayTime + 1) this.counts.lateCallbacks++;
    if (this.lastAt !== undefined) this.maxGapMs = Math.max(this.maxGapMs, now - this.lastAt);
    this.lastAt = now;
    if (!marker) { this.counts.corrupt++; return; }
    if (marker.run !== this.run) { this.counts.foreign++; return; }
    if (this.lastFrame !== undefined && marker.frame < this.lastFrame) {
      this.stop(now, 'VISUAL_COUNTER_RESET');
      return;
    }
    if (marker.frame === this.lastFrame) this.counts.duplicates++;
    else {
      this.counts.unique++;
      this.seconds[Math.floor((now - this.startedAt) / 1000)]++;
    }
    this.lastFrame = marker.frame;
    if (this.pending && marker.nonce === this.pending.nonce && expectedDisplayTime >= this.pending.at) {
      const latency = Math.ceil(expectedDisplayTime - this.pending.at);
      if (latency <= INPUT_TIMEOUT_MS) {
        this.histogram[latency]++;
        this.observedHistogram[Math.min(INPUT_TIMEOUT_MS,
          Math.ceil(Math.max(now, expectedDisplayTime) - this.pending.at))]++;
        this.counts.matched++;
        this.pending = undefined;
      }
    }
  }

  stop(at, reason = 'STOPPED') {
    if (this.endedAt !== undefined) return;
    this.endedAt = Math.max(this.startedAt, Math.min(at, this.deadline));
    this.reason = reason;
    if (this.pending) { this.counts.abandoned++; this.pending = undefined; }
  }

  snapshot(now) {
    this.tick(now);
    const elapsedMs = Math.max(0, (this.endedAt ?? now) - this.startedAt);
    const percentile = (histogram, fraction) => {
      if (!this.counts.matched) return null;
      const rank = Math.max(1, Math.ceil(this.counts.matched * fraction));
      let cumulative = 0;
      for (let milliseconds = 0; milliseconds < histogram.length; milliseconds++) {
        cumulative += histogram[milliseconds];
        if (cumulative >= rank) return milliseconds;
      }
      return null;
    };
    const percentiles = histogram => ({ min: percentile(histogram, 0),
      p50: percentile(histogram, 0.5), p95: percentile(histogram, 0.95),
      p99: percentile(histogram, 0.99), max: percentile(histogram, 1) });
    return { elapsedMs, reason: this.reason ?? 'RUNNING', ...this.counts, maxGapMs: this.maxGapMs,
      observedUniqueFps: elapsedMs ? this.counts.unique * 1000 / elapsedMs : 0,
      compositorFps: elapsedMs ? this.counts.presented * 1000 / elapsedMs : 0,
      latencyMs: percentiles(this.histogram),
      observedLatencyMs: percentiles(this.observedHistogram),
      unmatchedInputs: this.counts.inputs - this.counts.matched,
      latencyPoint: 'input-event-to-estimated-composition', histogramResolutionMs: 1,
      perSecondUnique: Array.from(this.seconds.subarray(0, Math.min(this.seconds.length, Math.ceil(elapsedMs / 1000)))) };
  }
}

/** Captures only the controlled marker ROI; exposes counters, never video pixels. */
export function observeVideo(video, options) {
  const collector = new MeasurementCollector(options);
  const canvas = document.createElement('canvas');
  canvas.width = MARKER.width;
  canvas.height = MARKER.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Marker canvas unavailable');
  let active = true;
  let callback;
  const next = (now, metadata) => {
    if (!active) return;
    context.drawImage(video, 0, 0, MARKER.width, MARKER.height, 0, 0, MARKER.width, MARKER.height);
    const marker = markerFromPixels(context.getImageData(0, 0, MARKER.width, MARKER.height));
    // Keep the later observation time separately; late callbacks must not understate latency.
    collector.observe(marker, metadata, Math.max(now, performance.now()));
    if (collector.endedAt === undefined) callback = video.requestVideoFrameCallback(next);
  };
  callback = video.requestVideoFrameCallback(next);
  return { collector, stop(reason = 'STOPPED') {
    active = false;
    video.cancelVideoFrameCallback(callback);
    collector.tick(performance.now());
    collector.stop(performance.now(), reason);
    return collector.snapshot(performance.now());
  } };
}

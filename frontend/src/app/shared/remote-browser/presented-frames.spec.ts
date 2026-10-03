import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentedFrames } from './presented-frames';

class VideoFrames {
  private sequence = 0;
  private callbacks = new Map<number, VideoFrameRequestCallback>();

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id);
  }

  next(): VideoFrameRequestCallback {
    const entry = this.callbacks.entries().next().value;
    if (!entry) throw new Error('No scheduled video callback');
    this.callbacks.delete(entry[0]);
    return entry[1];
  }

  present(): void {
    this.next()(performance.now(), {
      presentationTime: performance.now(),
      expectedDisplayTime: performance.now(),
      width: 1280,
      height: 720,
      mediaTime: 1,
      presentedFrames: this.sequence,
    });
  }
}

describe('decoded video freshness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requires decoded frames and detects a decoder stall even while capture stays active', () => {
    const video = new VideoFrames();
    const stalled = vi.fn();
    const frames = new PresentedFrames(video, vi.fn(), stalled);
    expect(frames.fresh).toBe(false);
    video.present();
    expect(frames.fresh).toBe(true);

    // Unchanged pixels still yield decoded frames from the continuous encoder.
    for (let frame = 0; frame < 4; frame++) {
      vi.advanceTimersByTime(1000);
      video.present();
    }
    expect(stalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(frames.fresh).toBe(false);
    expect(stalled).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(stalled).toHaveBeenCalledOnce();
  });

  it('fences a late callback from a replaced peer and releases its watchdog', () => {
    const video = new VideoFrames();
    const received = vi.fn();
    const stalled = vi.fn();
    const frames = new PresentedFrames(video, received, stalled);
    const late = video.next();
    frames.stop();
    late(performance.now(), {
      presentationTime: 0,
      expectedDisplayTime: 0,
      width: 1280,
      height: 720,
      mediaTime: 1,
      presentedFrames: 1,
    });
    vi.advanceTimersByTime(5000);
    expect(frames.fresh).toBe(false);
    expect(received).not.toHaveBeenCalled();
    expect(stalled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

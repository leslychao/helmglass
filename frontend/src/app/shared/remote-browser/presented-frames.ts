// The capture pipeline encodes continuously even when page pixels do not change.
const FRESHNESS_MS = 2000;

/** Owns decoded-frame freshness for one video peer, including late callback fencing. */
export class PresentedFrames {
  private active = true;
  private lastFrameAt?: number;
  private callback = 0;
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(
    private readonly video: Pick<
      HTMLVideoElement,
      'requestVideoFrameCallback' | 'cancelVideoFrameCallback'
    >,
    onFrame: () => void,
    onStall: () => void,
  ) {
    const presented: VideoFrameRequestCallback = () => {
      if (!this.active) return;
      this.lastFrameAt = performance.now();
      onFrame();
      if (this.active) this.callback = this.video.requestVideoFrameCallback(presented);
    };
    this.callback = this.video.requestVideoFrameCallback(presented);
    this.watchdog = setInterval(() => {
      if (!this.active || this.lastFrameAt === undefined || this.fresh) return;
      this.stop();
      onStall();
    }, 250);
  }

  get fresh(): boolean {
    return (
      this.active &&
      this.lastFrameAt !== undefined &&
      performance.now() - this.lastFrameAt < FRESHNESS_MS
    );
  }

  stop() {
    this.active = false;
    clearInterval(this.watchdog);
    this.video.cancelVideoFrameCallback(this.callback);
  }
}

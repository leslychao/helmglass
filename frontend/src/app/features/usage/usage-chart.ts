import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface UsagePoint {
  key: string;
  label: string;
  value: number | null;
  description: string;
  color?: string;
}

@Component({
  selector: 'hg-usage-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    class="svg-chart-v"
    viewBox="0 0 480 210"
    role="img"
    [attr.aria-label]="description()"
  >
    @for (tick of ticks(); track tick.value) {
      <line class="gridline" x1="32" [attr.y1]="tick.y" x2="474" [attr.y2]="tick.y" />
      <text x="26" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
    }
    @if (kind() === 'line') {
      <path [attr.d]="path()" fill="none" stroke="#4a8cff" stroke-width="2.5" />
    }
    @for (point of plotted(); track point.key; let index = $index) {
      @if (point.value !== null) {
        @if (kind() === 'bar') {
          <rect
            [attr.x]="point.x - barWidth() / 2"
            [attr.y]="point.y"
            [attr.width]="barWidth()"
            [attr.height]="155 - point.y"
            rx="3"
            [attr.fill]="point.color || '#4a8cff'"
          >
            <title>{{ point.description }}</title>
          </rect>
          <text [attr.x]="point.x" [attr.y]="point.y - 7" text-anchor="middle">
            {{ point.value }}
          </text>
        } @else {
          <circle [attr.cx]="point.x" [attr.cy]="point.y" r="3" fill="#4a8cff">
            <title>{{ point.description }}</title>
          </circle>
        }
      } @else {
        <text [attr.x]="point.x" y="155" text-anchor="middle">
          —
          <title>{{ point.description }}</title>
        </text>
      }
      @if (kind() === 'bar' || index % labelStep() === 0 || index === plotted().length - 1) {
        <text [attr.x]="point.x" y="182" text-anchor="middle" style="font-size:9px">
          {{ point.label }}
        </text>
      }
    }
  </svg>`,
})
export class UsageChart {
  readonly points = input.required<UsagePoint[]>();
  readonly kind = input<'bar' | 'line'>('bar');
  readonly description = computed(() =>
    this.points()
      .map((point) => point.description)
      .join('; '),
  );
  readonly maximum = computed(() => Math.max(1, ...this.points().map((point) => point.value ?? 0)));
  readonly barWidth = computed(() => Math.min(36, 300 / Math.max(1, this.points().length)));
  readonly labelStep = computed(() => Math.max(1, Math.ceil(this.points().length / 6)));
  readonly plotted = computed(() =>
    this.points().map((point, index, points) => ({
      ...point,
      x: points.length === 1 ? 250 : 50 + (index * 400) / (points.length - 1),
      y: 155 - ((point.value ?? 0) / this.maximum()) * 130,
    })),
  );
  readonly ticks = computed(() =>
    [0, 0.5, 1].map((fraction) => {
      const value = this.maximum() * fraction;
      return { value, label: Number(value.toFixed(1)), y: 155 - fraction * 130 };
    }),
  );
  readonly path = computed(() => {
    let connected = false;
    const segments: string[] = [];
    for (const point of this.plotted()) {
      if (point.value === null) {
        connected = false;
        continue;
      }
      segments.push(`${connected ? 'L' : 'M'}${point.x},${point.y}`);
      connected = true;
    }
    return segments.join(' ');
  });
}

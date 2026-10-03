import { ChangeDetectionStrategy, Component, input } from '@angular/core';

const paths: Readonly<Record<string, string>> = {
  tasks: 'M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01',
  plug: 'm9 3 0 4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5',
  chart: 'M4 19h16M7 15V9m5 6V4m5 11v-7',
  settings:
    'm12 3 2 3 3 .5 1 3 2 2-2 2-1 3-3 .5-2 3-2-3-3-.5-1-3-2-2 2-2 1-3L10 6l2-3Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h12v12H9ZM15 9V3H3v12h6',
  back: 'm10 5-7 7 7 7M3 12h18',
  search: 'M21 21l-5-5M18 10a8 8 0 1 0-16 0 8 8 0 0 0 16 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
  globe: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  clock: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0ZM12 7v5l3 2',
  browser: 'M3 4h18v16H3V4Zm0 4h18M6 6h.01M9 6h.01',
  lock: 'M5 11h14v10H5V11Zm3 0V7a4 4 0 0 1 8 0v4',
  refresh: 'M20 5v5h-5M4 19v-5h5M5 8a8 8 0 0 1 13-3l2 5M4 14l2 5a8 8 0 0 0 13-3',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 4 12 8-12 8V4Z',
  stop: 'M5 5h14v14H5Z',
  check: 'm5 12 4 4L19 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  chat: 'M21 4H3v13h4v4l5-4h9V4Z',
  menu: 'M3 5h18M3 12h18M3 19h18',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  history: 'M3 3v6h6M3 9a9 9 0 1 1 1 9M12 7v5l3 2',
  user: 'M4 21v-3a8 8 0 0 1 16 0v3M16 6a4 4 0 1 0-8 0 4 4 0 0 0 8 0',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-7h10v7',
  info: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0ZM12 11v6M12 7h.01',
  alert: 'M12 3 2 21h20L12 3ZM12 9v5M12 18h.01',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  file: 'M5 3h10l4 4v14H5ZM15 3v5h4M8 12h8M8 16h8',
  image: 'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M9 7h.01',
  database: 'M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0M4 6v12a8 3 0 0 0 16 0V6M4 12a8 3 0 0 0 16 0',
  server: 'M3 3h18v7H3ZM3 14h18v7H3ZM7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5',
  trend: 'M3 17l6-6 4 4 8-10M15 5h6v6',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6',
};
@Component({
  selector: 'hg-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="path()"/></svg>',
  styles:
    ':host{display:inline-flex;width:18px;height:18px;flex:none}svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}',
})
export class Icon {
  name = input.required<string>();
  path() {
    return paths[this.name()] ?? paths['info'];
  }
}

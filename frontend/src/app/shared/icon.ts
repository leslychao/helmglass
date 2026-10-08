import { Component, input } from '@angular/core';

export type IconName =
  | 'logout'
  | 'tasks'
  | 'plug'
  | 'chart'
  | 'bell'
  | 'user'
  | 'plus'
  | 'search'
  | 'filter'
  | 'close'
  | 'check'
  | 'clock'
  | 'play'
  | 'stop'
  | 'browser'
  | 'globe'
  | 'lock'
  | 'shield'
  | 'chat'
  | 'bolt'
  | 'file'
  | 'copy'
  | 'info'
  | 'alert'
  | 'trash'
  | 'edit'
  | 'external'
  | 'menu'
  | 'out'
  | 'list'
  | 'grid'
  | 'expand'
  | 'pause'
  | 'monitor'
  | 'save'
  | 'eye'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-left'
  | 'more'
  | 'camera'
  | 'image'
  | 'database'
  | 'gpt'
  | 'panel-right'
  | 'refresh';

@Component({
  selector: 'hg-icon',
  template: `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      @switch (name()) {
        @case ('logout') {
          <path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h10" />
        }
        @case ('tasks') {
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4" />
        }
        @case ('plug') {
          <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8zm6 9v5" />
        }
        @case ('chart') {
          <path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4" />
        }
        @case ('bell') {
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        }
        @case ('user') {
          <circle cx="12" cy="8" r="4" />
          <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
        }
        @case ('plus') {
          <path d="M12 5v14M5 12h14" />
        }
        @case ('search') {
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        }
        @case ('filter') {
          <path d="M4 6h16M7 12h10m-7 6h4" />
        }
        @case ('close') {
          <path d="m6 6 12 12M18 6 6 18" />
        }
        @case ('check') {
          <path d="m5 12 4 4L19 6" />
        }
        @case ('clock') {
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        }
        @case ('play') {
          <path d="m8 4 12 8-12 8V4z" />
        }
        @case ('stop') {
          <rect x="6" y="6" width="12" height="12" rx="2" />
        }
        @case ('browser') {
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M7 6.5h.1m3 0h.1" />
        }
        @case ('globe') {
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18z" />
        }
        @case ('lock') {
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" />
        }
        @case ('shield') {
          <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z" />
          <path d="m8 12 3 3 5-6" />
        }
        @case ('chat') {
          <path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0z" />
          <path d="M7 9h9m-9 5h6" />
        }
        @case ('bolt') {
          <path d="m13 2-9 12h7l-1 8 10-13h-8l1-7z" />
        }
        @case ('file') {
          <path d="M14 2H5v20h14V7l-5-5zM14 2v6h5M8 13h8m-8 4h6" />
        }
        @case ('copy') {
          <rect x="8" y="8" width="13" height="13" rx="2" />
          <path d="M16 8V3H3v13h5" />
        }
        @case ('info') {
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6m0-10h.01" />
        }
        @case ('alert') {
          <path d="m12 3 10 18H2L12 3zM12 9v5m0 3h.01" />
        }
        @case ('trash') {
          <path d="M4 6h16M9 6V3h6v3m-9 0 1 15h10l1-15M10 10v7m4-7v7" />
        }
        @case ('edit') {
          <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6z" />
        }
        @case ('external') {
          <path d="M14 3h7v7m0-7L10 14M9 4H4v16h16v-5" />
        }
        @case ('menu') {
          <path d="M4 6h16M4 12h16M4 18h16" />
        }
        @case ('out') {
          <path d="M9 4H4v16h5m6-13 5 5-5 5M8 12h12" />
        }
        @case ('list') {
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1" />
        }
        @case ('grid') {
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        }
        @case ('expand') {
          <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
        }
        @case ('pause') {
          <path d="M8 4v16m8-16v16" />
        }
        @case ('monitor') {
          <rect x="3" y="3" width="18" height="13" rx="1" />
          <path d="M12 16v5m-5 0h10" />
        }
        @case ('save') {
          <path d="M4 3h13l4 4v14H3V3h1zM7 3v6h10V3M7 21v-8h10v8" />
        }
        @case ('eye') {
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        }
        @case ('chevron-right') {
          <path d="m9 5 7 7-7 7" />
        }
        @case ('chevron-down') {
          <path d="m6 9 6 6 6-6" />
        }
        @case ('arrow-left') {
          <path d="m14 5-7 7 7 7" />
        }
        @case ('more') {
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        }
        @case ('camera') {
          <path d="M4 7h4l2-3h4l2 3h4v14H4z" />
          <circle cx="12" cy="13" r="4" />
        }
        @case ('image') {
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        }
        @case ('database') {
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
        }
        @case ('gpt') {
          <path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0z" />
          <path d="M7 9h9m-9 5h6" />
        }
        @case ('panel-right') {
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16m-5-11 3 3-3 3" />
        }
        @case ('refresh') {
          <path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 1l1 5M4 12l1 5a8 8 0 0 0 13 1" />
        }
      }
    </svg>
  `,
  styles:
    ':host { display: inline-flex; align-items: center; justify-content: center; flex: none; vertical-align: middle; line-height: 0; }',
})
export class Icon {
  readonly name = input.required<IconName>();
}

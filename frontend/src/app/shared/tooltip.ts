import { FocusMonitor } from '@angular/cdk/a11y';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { Component, DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

@Component({
  selector: 'hg-tooltip-content',
  host: { class: 'tooltip-content', role: 'tooltip', '[id]': 'id()' },
  template: '{{ text() }}',
})
class TooltipContent {
  readonly id = input('');
  readonly text = input('');
}

let nextTooltipId = 0;

@Directive({
  selector: '[hgTooltip]',
  host: {
    '(mouseenter)': 'show()',
    '(mouseleave)': 'leave()',
    '(pointerdown)': 'dismiss()',
  },
})
export class Tooltip {
  readonly hgTooltip = input<string | null | undefined>('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly focusMonitor = inject(FocusMonitor);
  private readonly overlay = inject(Overlay);
  private readonly id = 'helm-tooltip-' + ++nextTooltipId;
  private panel: OverlayRef | null = null;
  private keyboardFocused = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    this.hide();
  };

  constructor() {
    this.focusMonitor
      .monitor(this.host, true)
      .pipe(takeUntilDestroyed())
      .subscribe((origin) => {
        this.keyboardFocused = origin === 'keyboard';
        if (this.keyboardFocused) this.show();
        else this.leave();
      });
    effect(() => {
      this.hgTooltip();
      this.hide();
    });
    inject(DestroyRef).onDestroy(() => {
      this.focusMonitor.stopMonitoring(this.host);
      this.hide();
    });
  }

  show() {
    clearTimeout(this.hideTimer);
    const text = this.hgTooltip()?.trim();
    if (this.panel || !text) return;
    const position = this.overlay
      .position()
      .flexibleConnectedTo(this.host)
      .withPositions([
        { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 },
        { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
      ])
      .withViewportMargin(12)
      .withPush(true);
    const panel = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'tooltip-overlay',
    });
    this.panel = panel;
    const component = panel.attach(new ComponentPortal(TooltipContent));
    component.setInput('id', this.id);
    component.setInput('text', text);
    const describedBy =
      this.host.nativeElement.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    this.host.nativeElement.setAttribute('aria-describedby', [...describedBy, this.id].join(' '));
    panel.overlayElement.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    panel.overlayElement.addEventListener('mouseleave', () => this.leave());
    document.addEventListener('keydown', this.escape, true);
  }

  leave() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (
        !this.keyboardFocused &&
        !this.host.nativeElement.matches(':hover') &&
        !this.panel?.overlayElement.matches(':hover')
      )
        this.hide();
    }, 100);
  }

  dismiss() {
    this.keyboardFocused = false;
    this.hide();
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.panel?.dispose();
    this.panel = null;
    document.removeEventListener('keydown', this.escape, true);
    const describedBy = (this.host.nativeElement.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter((value) => value && value !== this.id)
      .join(' ');
    if (describedBy) this.host.nativeElement.setAttribute('aria-describedby', describedBy);
    else this.host.nativeElement.removeAttribute('aria-describedby');
  }
}

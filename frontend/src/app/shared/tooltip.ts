import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { Component, DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';

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
    '(focusin)': 'show()',
    '(focusout)': 'leave()',
    '(pointerdown)': 'hide()',
  },
})
export class Tooltip {
  readonly hgTooltip = input<string | null | undefined>('');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly id = 'helm-tooltip-' + ++nextTooltipId;
  private panel: OverlayRef | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    this.hide();
  };

  constructor() {
    effect(() => {
      this.hgTooltip();
      this.hide();
    });
    inject(DestroyRef).onDestroy(() => this.hide());
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
      if (!this.host.nativeElement.matches(':hover, :focus-within')) this.hide();
    }, 100);
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

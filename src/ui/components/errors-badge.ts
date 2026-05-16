/**
 * Active-error indicator — warning triangle + count chip.
 *
 * Two flavours:
 *   - `floating` : top-right persistent icon (like AccountStatusIcon) for
 *                  hub / status / services / account / bt screens.
 *   - `inline`   : drop-in for the NavBar (control screen).
 *
 * Both subscribe to ErrorStore "change" events and toggle visibility:
 *   zero errors → hidden, one or more → visible with the count.
 */

import type { ErrorStore } from '../../protocol/error-store';
import { ErrorsPopover } from './errors-popover';

const WARNING_SVG = (color: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
  <line x1="12" y1="9" x2="12" y2="13"/>
  <line x1="12" y1="17" x2="12.01" y2="17"/>
</svg>`;

export type ErrorsBadgeFlavour = 'floating' | 'inline';

export class ErrorsBadge {
  private container: HTMLElement;
  private iconWrap: HTMLElement;
  private countEl: HTMLElement;
  private unsubscribe: () => void;
  private flavour: ErrorsBadgeFlavour;
  private popover: ErrorsPopover;

  constructor(parent: HTMLElement, store: ErrorStore, flavour: ErrorsBadgeFlavour = 'floating') {
    this.flavour = flavour;
    this.container = document.createElement('div');
    this.container.className = `errors-badge errors-badge-${flavour}`;
    this.container.title = 'Robot errors';

    if (flavour === 'floating') {
      // Sits to the left of the account-status icon (right:102 + 36 + 8 = 146).
      this.container.style.cssText =
        'position:fixed;top:12px;right:146px;z-index:9000;display:none;align-items:center;' +
        'cursor:pointer;pointer-events:auto;';
    } else {
      this.container.style.cssText =
        'display:none;align-items:center;cursor:pointer;margin-left:4px;';
    }

    this.iconWrap = document.createElement('div');
    this.iconWrap.style.cssText =
      'position:relative;width:36px;height:36px;border-radius:50%;' +
      'background:rgba(26,29,35,0.95);border:1.5px solid rgba(255,61,61,0.55);' +
      'display:flex;align-items:center;justify-content:center;' +
      'transition:background 0.15s,transform 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    this.iconWrap.innerHTML = WARNING_SVG('#FF3D3D');

    this.countEl = document.createElement('span');
    this.countEl.style.cssText =
      'position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;' +
      'border-radius:9px;background:#FF3D3D;color:#fff;font-size:11px;font-weight:700;' +
      'line-height:18px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);' +
      'pointer-events:none;';
    this.countEl.textContent = '0';
    this.iconWrap.appendChild(this.countEl);

    this.container.appendChild(this.iconWrap);

    // Single popover shared by both badge flavours; anchored to whichever
    // badge is clicked. Centrally owned so destroy() tears it down cleanly.
    this.popover = new ErrorsPopover(store);
    this.container.addEventListener('click', () => this.popover.toggle(this.container));
    this.container.addEventListener('mouseenter', () => {
      this.iconWrap.style.background = 'rgba(255,61,61,0.18)';
      this.iconWrap.style.transform = 'scale(1.05)';
    });
    this.container.addEventListener('mouseleave', () => {
      this.iconWrap.style.background = 'rgba(26,29,35,0.95)';
      this.iconWrap.style.transform = 'scale(1)';
    });

    parent.appendChild(this.container);

    this.unsubscribe = store.subscribe((evt) => {
      if (evt.kind === 'change') this.render(evt.errors.length);
    });
    this.render(store.count());
  }

  /** Root element — exposed so callers can reposition it in their own layout. */
  get element(): HTMLElement {
    return this.container;
  }

  setVisible(visible: boolean): void {
    // The badge auto-hides when count = 0; this lets callers fully suppress it
    // on screens where it shouldn't appear at all (e.g. landing pre-connect).
    this.container.dataset.suppressed = visible ? '' : '1';
    this.applyDisplay();
  }

  private render(count: number): void {
    this.countEl.textContent = String(count);
    this.container.dataset.empty = count === 0 ? '1' : '';
    this.applyDisplay();
  }

  private applyDisplay(): void {
    const suppressed = this.container.dataset.suppressed === '1';
    const empty = this.container.dataset.empty === '1';
    this.container.style.display = (suppressed || empty) ? 'none' : (this.flavour === 'floating' ? 'flex' : 'inline-flex');
  }

  destroy(): void {
    this.unsubscribe();
    this.popover.destroy();
    this.container.remove();
  }
}

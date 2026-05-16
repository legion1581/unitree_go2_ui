/**
 * Compact dropdown listing currently-active robot faults — opened by
 * clicking the ErrorsBadge. Shows up to four entries before scrolling;
 * dismisses on outside-click or when the active set becomes empty.
 */

import type { ErrorStore } from '../../protocol/error-store';
import type { DecodedError } from '../../protocol/errors-catalog';

const MAX_VISIBLE_ROWS = 4;

export class ErrorsPopover {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private store: ErrorStore;
  private unsubscribe: () => void;
  private outsideClickHandler: ((e: PointerEvent) => void) | null = null;
  private open = false;

  constructor(store: ErrorStore) {
    this.store = store;
    this.container = document.createElement('div');
    this.container.className = 'errors-popover';
    this.container.style.cssText =
      'position:fixed;display:none;z-index:9600;width:340px;' +
      'background:rgba(20,22,28,0.98);border:1px solid #2a2d35;border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.5);' +
      'overflow:hidden;';

    const header = document.createElement('div');
    header.className = 'errors-popover-header';
    header.style.cssText =
      'padding:9px 12px;border-bottom:1px solid #1f2229;' +
      'font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;' +
      'color:#FF6B6B;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = `
      <span>Active errors</span>
      <span class="errors-popover-count" style="color:#888;font-weight:600;font-size:10px;">0</span>
    `;
    this.container.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = 'errors-popover-list';
    // ~58px per row × 4 rows; overflow scrolls
    this.listEl.style.cssText =
      'max-height:232px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2a2d35 transparent;';
    this.container.appendChild(this.listEl);

    document.body.appendChild(this.container);

    this.unsubscribe = store.subscribe((evt) => {
      if (evt.kind !== 'change') return;
      if (evt.errors.length === 0 && this.open) this.close();
      if (this.open) this.render();
    });
  }

  /** Open the popover anchored under `anchor`. If already open, closes. */
  toggle(anchor: HTMLElement): void {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    this.position(anchor);
    this.render();
    this.container.style.display = 'block';

    // Outside-click dismiss — same pattern as nav-temp-popover.
    setTimeout(() => {
      this.outsideClickHandler = (e: PointerEvent) => {
        if (!this.open) return;
        const t = e.target as Node;
        if (this.container.contains(t)) return;
        if (anchor.contains(t)) return;
        this.close();
      };
      document.addEventListener('pointerdown', this.outsideClickHandler);
    }, 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.container.style.display = 'none';
    if (this.outsideClickHandler) {
      document.removeEventListener('pointerdown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  destroy(): void {
    this.close();
    this.unsubscribe();
    this.container.remove();
  }

  private position(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const popW = 340;
    const margin = 8;
    // Anchor right edge of popover to right edge of badge — keeps a sensible
    // drop-down feel for both the NavBar inline badge and the floating one.
    let left = r.right - popW;
    if (left < margin) left = margin;
    if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
    this.container.style.left = `${left}px`;
    this.container.style.top = `${r.bottom + 6}px`;
  }

  private render(): void {
    const errors = this.store.list();
    const countEl = this.container.querySelector('.errors-popover-count')!;
    countEl.textContent = `${errors.length} active`;

    if (errors.length === 0) {
      this.listEl.innerHTML =
        '<div style="padding:18px 12px;text-align:center;color:#555;font-size:12px;">No active errors.</div>';
      return;
    }

    this.listEl.innerHTML = '';
    for (const err of errors) {
      this.listEl.appendChild(this.buildRow(err));
    }
  }

  private buildRow(err: DecodedError): HTMLElement {
    const row = document.createElement('div');
    row.className = 'errors-popover-row';
    row.style.cssText =
      'padding:10px 12px;border-bottom:1px solid rgba(26,29,35,0.7);' +
      'display:flex;align-items:center;gap:10px;';
    row.innerHTML = `
      <div style="width:6px;height:6px;border-radius:50%;background:#FF3D3D;flex:0 0 auto;"></div>
      <div style="flex:1;min-width:0;">
        <div style="color:#e0e0e0;font-size:13px;font-weight:500;line-height:1.3;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${this.esc(err.codeLabel)}
        </div>
        <div style="color:#888;font-size:10.5px;margin-top:2px;line-height:1.2;">
          ${this.esc(err.sourceLabel)}
          <span style="color:#555;"> · </span>
          <span style="font-family:monospace;color:#999;">${err.source}/0x${err.code.toString(16)}</span>
        </div>
      </div>
      <div style="font-size:10.5px;color:#6a6f7a;flex:0 0 auto;font-variant-numeric:tabular-nums;"
           title="${this.fmtAbs(err.timestamp)}">
        ${this.fmtRel(err.timestamp)}
      </div>
    `;
    return row;
  }

  private fmtRel(ts: number): string {
    const diff = Date.now() - ts * 1000;
    if (diff < 0) return 'just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  private fmtAbs(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }
}

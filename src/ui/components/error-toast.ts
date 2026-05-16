/**
 * Transient toast for newly-appeared robot faults.
 *
 * Listens to ErrorStore "added" events (deltas — does NOT fire on the
 * initial snapshot, so reconnect doesn't spam toasts). Stacks bottom-right,
 * auto-dismisses after ~4s; clicking a toast dismisses it immediately.
 */

import type { ErrorStore } from '../../protocol/error-store';
import type { DecodedError } from '../../protocol/errors-catalog';

const WARNING_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
  <line x1="12" y1="9" x2="12" y2="13"/>
  <line x1="12" y1="17" x2="12.01" y2="17"/>
</svg>`;

const TOAST_LIFETIME_MS = 4500;

export class ErrorToastHost {
  private container: HTMLElement;
  private unsubscribe: () => void;

  constructor(parent: HTMLElement, store: ErrorStore) {
    this.container = document.createElement('div');
    this.container.className = 'error-toast-host';
    this.container.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:9500;' +
      'display:flex;flex-direction:column;gap:8px;align-items:flex-end;' +
      'pointer-events:none;';
    parent.appendChild(this.container);

    this.unsubscribe = store.subscribe((evt) => {
      if (evt.kind === 'added') this.spawn(evt.error);
    });
  }

  private spawn(err: DecodedError): void {
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.style.cssText =
      'pointer-events:auto;min-width:260px;max-width:380px;' +
      'background:rgba(20,22,28,0.97);border:1px solid rgba(255,61,61,0.55);' +
      'border-left:4px solid #FF3D3D;border-radius:6px;' +
      'padding:10px 12px;box-shadow:0 6px 18px rgba(0,0,0,0.45);' +
      'display:flex;gap:10px;align-items:flex-start;cursor:pointer;' +
      'transform:translateX(20px);opacity:0;transition:transform 180ms ease-out,opacity 180ms ease-out;';

    const icon = document.createElement('div');
    icon.style.cssText =
      'width:28px;height:28px;border-radius:50%;background:#FF3D3D;' +
      'display:flex;align-items:center;justify-content:center;flex:0 0 auto;';
    icon.innerHTML = WARNING_SVG;

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;';
    body.innerHTML = `
      <div style="color:#fff;font-size:13px;font-weight:600;line-height:1.3;">${this.esc(err.codeLabel)}</div>
      <div style="color:#b0b3bb;font-size:11px;margin-top:2px;">${this.esc(err.sourceLabel)}
        <span style="color:#666;"> · </span>
        <span style="font-family:monospace;color:#888;">${err.source}/0x${err.code.toString(16)}</span>
      </div>
    `;

    toast.appendChild(icon);
    toast.appendChild(body);
    this.container.appendChild(toast);

    // Slide-in
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(0)';
      toast.style.opacity = '1';
    });

    const dismiss = (): void => {
      if (!toast.isConnected) return;
      toast.style.transform = 'translateX(20px)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    };

    toast.addEventListener('click', dismiss);
    setTimeout(dismiss, TOAST_LIFETIME_MS);
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  destroy(): void {
    this.unsubscribe();
    this.container.remove();
  }
}

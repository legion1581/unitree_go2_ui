/**
 * Full-screen list of currently-active robot faults.
 *
 * Mirrors the APK's ErrorsActivity layout (activity_errors.xml + item_dog_error.xml):
 * source label · code chip · "appeared at" timestamp. Subscribes to ErrorStore
 * "change" events and re-renders the visible list in place.
 *
 * Errors are grouped by source category so related faults (e.g. several motor
 * faults at once) cluster together.
 */

import type { ErrorStore } from '../../protocol/error-store';
import type { DecodedError } from '../../protocol/errors-catalog';

export class ErrorsPage {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private badgeEl: HTMLElement;
  private unsubscribe: () => void;

  constructor(parent: HTMLElement, store: ErrorStore, onBack: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'errors-page';

    // Header — same shape as Services / Status pages
    const header = document.createElement('div');
    header.className = 'page-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', onBack);
    header.appendChild(backBtn);

    const title = document.createElement('h2');
    title.textContent = 'Errors';
    header.appendChild(title);

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'page-header-badge';
    header.appendChild(this.badgeEl);

    this.container.appendChild(header);

    // Scrollable list
    const content = document.createElement('div');
    content.className = 'page-content errors-page-content';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'errors-empty';
    this.emptyEl.textContent = 'No active errors.';
    content.appendChild(this.emptyEl);

    this.listEl = document.createElement('div');
    this.listEl.className = 'errors-list';
    content.appendChild(this.listEl);

    this.container.appendChild(content);
    parent.appendChild(this.container);

    this.unsubscribe = store.subscribe((evt) => {
      if (evt.kind === 'change') this.render(evt.errors);
    });
    this.render(store.list());
  }

  private render(errors: DecodedError[]): void {
    this.badgeEl.textContent = `${errors.length} active`;
    this.badgeEl.style.color = errors.length === 0 ? '#42CF55' : '#FF3D3D';
    this.badgeEl.style.background = errors.length === 0
      ? 'rgba(66, 207, 85, 0.10)'
      : 'rgba(255, 61, 61, 0.10)';

    if (errors.length === 0) {
      this.emptyEl.style.display = 'block';
      this.listEl.style.display = 'none';
      this.listEl.innerHTML = '';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.listEl.style.display = '';

    // Group by source so related faults sit together; sources in ascending
    // numeric order, errors within a group newest-first by timestamp.
    const groups = new Map<number, DecodedError[]>();
    for (const e of errors) {
      const arr = groups.get(e.source) ?? [];
      arr.push(e);
      groups.set(e.source, arr);
    }
    const sourceOrder = Array.from(groups.keys()).sort((a, b) => a - b);

    this.listEl.innerHTML = '';
    for (const source of sourceOrder) {
      const entries = groups.get(source)!.sort((a, b) => b.timestamp - a.timestamp);
      const sectionLabel = entries[0].sourceLabel;

      const section = document.createElement('div');
      section.className = 'errors-section';

      const heading = document.createElement('div');
      heading.className = 'errors-section-heading';
      heading.innerHTML = `
        <span class="errors-section-source">${this.esc(sectionLabel)}</span>
        <span class="errors-section-code">${source}</span>
      `;
      section.appendChild(heading);

      for (const e of entries) {
        section.appendChild(this.buildRow(e));
      }

      this.listEl.appendChild(section);
    }
  }

  private buildRow(err: DecodedError): HTMLElement {
    const row = document.createElement('div');
    row.className = 'errors-row';
    row.innerHTML = `
      <div class="errors-row-main">
        <span class="errors-row-label">${this.esc(err.codeLabel)}</span>
        <span class="errors-row-code">0x${err.code.toString(16)}</span>
      </div>
      <div class="errors-row-time" title="${this.fmtAbs(err.timestamp)}">
        <span class="errors-row-time-abs">${this.fmtClock(err.timestamp)}</span>
        <span class="errors-row-time-rel">${this.fmtRel(err.timestamp)}</span>
      </div>
    `;
    return row;
  }

  private fmtClock(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
  }

  private fmtRel(ts: number): string {
    const ms = ts * 1000;
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  private fmtAbs(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
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

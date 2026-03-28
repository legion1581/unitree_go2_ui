export interface ServiceEntry {
  name: string;
  status: number;   // raw: 0 = running, 1 = stopped (inverted from what you'd expect)
  protect: boolean;
  version?: string;
}

interface RowElements {
  row: HTMLElement;
  dot: HTMLElement;
  statusSpan: HTMLElement;
  versionSpan: HTMLElement;
  btn: HTMLButtonElement;
}

interface PendingToggle {
  previousStatus: number;  // status before toggle was clicked
  timeoutId: number;
}

export class ServicesPage {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private badgeEl: HTMLElement;
  private loadingEl: HTMLElement;
  private services: ServiceEntry[] = [];
  private onBack: () => void;
  private onToggle: (name: string, enable: boolean) => void;
  private pendingToggles: Map<string, PendingToggle> = new Map();
  private rowMap: Map<string, RowElements> = new Map();
  private sortedNames: string[] = [];
  private updateTimer = 0;
  private pendingServices: ServiceEntry[] | null = null;

  constructor(
    parent: HTMLElement,
    onBack: () => void,
    onToggle: (name: string, enable: boolean) => void,
  ) {
    this.onBack = onBack;
    this.onToggle = onToggle;

    this.container = document.createElement('div');
    this.container.className = 'services-page';

    // Header
    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', onBack);
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = 'Services';
    header.appendChild(title);
    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'page-header-badge';
    header.appendChild(this.badgeEl);
    this.container.appendChild(header);

    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'services-loading';
    this.loadingEl.textContent = 'Waiting for service data...';
    this.container.appendChild(this.loadingEl);

    this.listEl = document.createElement('div');
    this.listEl.className = 'services-list';
    this.container.appendChild(this.listEl);

    parent.appendChild(this.container);
  }

  update(services: ServiceEntry[]): void {
    this.pendingServices = services;
    if (this.updateTimer) return;
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      if (this.pendingServices) {
        this.applyUpdate(this.pendingServices);
        this.pendingServices = null;
      }
    }, 300);
  }

  private applyUpdate(services: ServiceEntry[]): void {
    this.services = services;
    this.loadingEl.style.display = services.length > 0 ? 'none' : '';

    // Update badge
    if (services.length > 0) {
      const running = services.filter((s) => s.status === 0).length;
      this.badgeEl.textContent = `${running}/${services.length} running`;
    }

    // Clear pending toggles ONLY when the status actually changed
    for (const svc of services) {
      const pending = this.pendingToggles.get(svc.name);
      if (pending && svc.status !== pending.previousStatus) {
        // Status actually changed — clear the waiting state
        clearTimeout(pending.timeoutId);
        this.pendingToggles.delete(svc.name);
      }
    }

    // Build rows if service list changed, otherwise just update values
    const newNames = [...services].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.name);
    const structureChanged = newNames.length !== this.sortedNames.length ||
      newNames.some((n, i) => n !== this.sortedNames[i]);

    if (structureChanged) {
      this.rebuildRows(services);
    } else {
      this.updateRows(services);
    }
  }

  /** Build all DOM rows from scratch (only on first load or structure change). */
  private rebuildRows(services: ServiceEntry[]): void {
    const sorted = [...services].sort((a, b) => a.name.localeCompare(b.name));
    this.sortedNames = sorted.map((s) => s.name);
    this.rowMap.clear();
    this.listEl.innerHTML = '';

    for (const svc of sorted) {
      const row = document.createElement('div');
      row.className = 'svc-row';
      row.dataset.name = svc.name;

      const info = document.createElement('div');
      info.className = 'svc-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'svc-name-row';

      const dot = document.createElement('span');
      dot.className = 'svc-status-dot';
      nameRow.appendChild(dot);

      const nameEl = document.createElement('span');
      nameEl.className = 'svc-name';
      nameEl.textContent = svc.name;
      nameRow.appendChild(nameEl);

      if (svc.protect) {
        const shield = document.createElement('span');
        shield.className = 'svc-shield';
        shield.textContent = '\u{1F512}';
        nameRow.appendChild(shield);
      }

      info.appendChild(nameRow);

      const meta = document.createElement('span');
      meta.className = 'svc-meta';
      const statusSpan = document.createElement('span');
      meta.appendChild(statusSpan);
      const versionSpan = document.createElement('span');
      versionSpan.className = 'svc-version';
      meta.appendChild(versionSpan);
      info.appendChild(meta);

      row.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'svc-toggle';
      btn.addEventListener('click', () => {
        const current = this.services.find((s) => s.name === svc.name);
        if (!current) return;
        const running = current.status === 0;
        this.handleToggle(svc.name, !running, current.status);
      });
      row.appendChild(btn);

      this.listEl.appendChild(row);
      this.rowMap.set(svc.name, { row, dot, statusSpan, versionSpan, btn });
    }

    this.updateRows(services);
  }

  /** Update only the values in existing DOM rows — no DOM creation. */
  private updateRows(services: ServiceEntry[]): void {
    for (const svc of services) {
      const els = this.rowMap.get(svc.name);
      if (!els) continue;

      const running = svc.status === 0;
      const isPending = this.pendingToggles.has(svc.name);

      // Status dot
      els.dot.className = `svc-status-dot ${running ? 'svc-status-running' : 'svc-status-stopped'}`;

      // Status text
      els.statusSpan.textContent = running ? 'Running' : 'Stopped';
      els.statusSpan.className = running ? 'svc-status-running' : 'svc-status-stopped';

      // Version
      els.versionSpan.textContent = svc.version ? `v${svc.version}` : '';

      // Button
      if (isPending) {
        els.btn.textContent = 'Wait...';
        els.btn.className = 'svc-toggle svc-btn-waiting';
        els.btn.disabled = true;
      } else {
        els.btn.textContent = running ? 'Stop' : 'Start';
        els.btn.className = `svc-toggle ${running ? 'svc-btn-stop' : 'svc-btn-start'}`;
        els.btn.disabled = false;
      }
    }
  }

  private handleToggle(name: string, enable: boolean, previousStatus: number): void {
    this.onToggle(name, enable);

    // Mark as pending — clear only when status actually changes, or after 5s
    const timeoutId = window.setTimeout(() => {
      this.pendingToggles.delete(name);
      this.updateRows(this.services);
    }, 10000);
    this.pendingToggles.set(name, { previousStatus, timeoutId });

    this.updateRows(this.services);
  }

  showProtectedError(name: string): void {
    const pending = this.pendingToggles.get(name);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingToggles.delete(name);
    }
    this.updateRows(this.services);

    const els = this.rowMap.get(name);
    if (els) {
      const existing = els.row.querySelector('.svc-error');
      if (existing) existing.remove();
      const err = document.createElement('div');
      err.className = 'svc-error';
      err.textContent = 'Protected — cannot toggle';
      els.row.appendChild(err);
      setTimeout(() => err.remove(), 3000);
    }
  }
}

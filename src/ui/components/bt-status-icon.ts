/**
 * Floating Bluetooth status indicator (upper-right corner).
 * Polls the BLE server and shows grey/blue based on whether
 * a robot or remote is currently connected via BLE.
 */

const BLE_API = '/ble-api';

const BT_SVG = (color: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5L6.5 17.5"/>
</svg>`;

export interface BluetoothStatus {
  robotConnected: boolean;
  robotAddress: string;
  remoteConnected: boolean;
  remoteName: string;
  remoteAddress: string;
}

export class BtStatusIcon {
  private container: HTMLElement;
  private iconWrap: HTMLElement;
  private tooltip: HTMLElement;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: BluetoothStatus = {
    robotConnected: false, robotAddress: '',
    remoteConnected: false, remoteName: '', remoteAddress: '',
  };
  private statusChangeListeners: Array<(s: BluetoothStatus) => void> = [];

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'bt-status-icon';
    this.container.style.cssText = 'position:fixed;top:12px;right:14px;z-index:9000;display:flex;align-items:center;pointer-events:auto;';

    this.iconWrap = document.createElement('div');
    this.iconWrap.style.cssText = 'width:32px;height:32px;border-radius:50%;background:rgba(15,17,20,0.7);border:1px solid #1f2229;display:flex;align-items:center;justify-content:center;cursor:default;';
    this.iconWrap.innerHTML = BT_SVG('#666');
    this.container.appendChild(this.iconWrap);

    this.tooltip = document.createElement('div');
    this.tooltip.style.cssText = 'position:absolute;top:38px;right:0;background:rgba(15,17,20,0.95);border:1px solid #1f2229;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;white-space:nowrap;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    this.container.appendChild(this.tooltip);

    this.iconWrap.addEventListener('mouseenter', () => { this.tooltip.style.display = 'block'; });
    this.iconWrap.addEventListener('mouseleave', () => { this.tooltip.style.display = 'none'; });

    parent.appendChild(this.container);
    this.startPolling();
  }

  onStatusChange(cb: (s: BluetoothStatus) => void): void {
    this.statusChangeListeners.push(cb);
  }

  getStatus(): BluetoothStatus {
    return { ...this.lastStatus };
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? 'flex' : 'none';
  }

  private async poll(): Promise<void> {
    let status: BluetoothStatus = {
      robotConnected: false, robotAddress: '',
      remoteConnected: false, remoteName: '', remoteAddress: '',
    };

    try {
      const [robotResp, remoteResp] = await Promise.allSettled([
        fetch(`${BLE_API}/status`, { signal: AbortSignal.timeout(2000) }),
        fetch(`${BLE_API}/remote/status`, { signal: AbortSignal.timeout(2000) }),
      ]);

      if (robotResp.status === 'fulfilled' && robotResp.value.ok) {
        const s = await robotResp.value.json();
        status.robotConnected = s.connected;
        status.robotAddress = s.address || '';
      }
      if (remoteResp.status === 'fulfilled' && remoteResp.value.ok) {
        const s = await remoteResp.value.json();
        status.remoteConnected = s.connected;
        status.remoteAddress = s.address || '';
        status.remoteName = s.name || '';
      }
    } catch { /* server offline */ }

    const connected = status.robotConnected || status.remoteConnected;
    const color = connected ? '#4fc3f7' : '#666';
    this.iconWrap.innerHTML = BT_SVG(color);
    this.iconWrap.style.borderColor = connected ? 'rgba(79,195,247,0.4)' : '#1f2229';

    // Tooltip content
    const lines: string[] = [];
    if (status.robotConnected) lines.push(`<div><strong style="color:#4fc3f7;">Robot:</strong> ${this.esc(status.robotAddress)}</div>`);
    if (status.remoteConnected) {
      const label = status.remoteName || status.remoteAddress;
      lines.push(`<div><strong style="color:#4fc3f7;">Remote:</strong> ${this.esc(label)}</div>`);
    }
    if (!connected) lines.push('<div style="color:#888;">Bluetooth: not connected</div>');
    this.tooltip.innerHTML = lines.join('');

    // Fire listeners if anything changed
    const changed = status.robotConnected !== this.lastStatus.robotConnected
      || status.remoteConnected !== this.lastStatus.remoteConnected
      || status.robotAddress !== this.lastStatus.robotAddress
      || status.remoteAddress !== this.lastStatus.remoteAddress;
    this.lastStatus = status;
    if (changed) {
      for (const cb of this.statusChangeListeners) cb(status);
    }
  }

  private startPolling(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 3000);
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.container.remove();
  }
}

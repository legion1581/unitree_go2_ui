/**
 * Floating Bluetooth status indicator (upper-right corner).
 * Passive: shows connection state via icon color; hover reveals device tooltip.
 * Subscribes to the shared BLE backend WebSocket for push-based status updates.
 */

import { btBackend } from '../../api/bt-backend';

const BT_SVG = (color: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
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
  private unsubscribe: (() => void) | null = null;
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
    this.iconWrap.style.cssText = 'width:36px;height:36px;border-radius:50%;background:rgba(26,29,35,0.95);border:1.5px solid #3a3d45;display:flex;align-items:center;justify-content:center;cursor:default;transition:background 0.15s,border-color 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    this.iconWrap.innerHTML = BT_SVG('#b0b3bb');
    this.container.appendChild(this.iconWrap);

    this.tooltip = document.createElement('div');
    this.tooltip.style.cssText = 'position:absolute;top:38px;right:0;background:rgba(15,17,20,0.95);border:1px solid #1f2229;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;white-space:nowrap;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    this.container.appendChild(this.tooltip);

    this.iconWrap.addEventListener('mouseenter', () => {
      this.tooltip.style.display = 'block';
    });
    this.iconWrap.addEventListener('mouseleave', () => {
      this.tooltip.style.display = 'none';
    });

    parent.appendChild(this.container);
    this.unsubscribe = btBackend().subscribe('status', (msg) => this.handleStatus(msg));
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

  private handleStatus(msg: { robot: { connected: boolean; address: string; protocol: string }; remote: { connected: boolean; address: string; name: string } }): void {
    const status: BluetoothStatus = {
      robotConnected: msg.robot.connected,
      robotAddress: msg.robot.address || '',
      remoteConnected: msg.remote.connected,
      remoteAddress: msg.remote.address || '',
      remoteName: msg.remote.name || '',
    };

    const connected = status.robotConnected || status.remoteConnected;
    const color = connected ? '#4fc3f7' : '#b0b3bb';
    this.iconWrap.innerHTML = BT_SVG(color);
    this.iconWrap.style.borderColor = connected ? 'rgba(79,195,247,0.5)' : '#3a3d45';
    this.iconWrap.style.background = connected ? 'rgba(79,195,247,0.15)' : 'rgba(26,29,35,0.95)';

    const lines: string[] = [];
    if (status.robotConnected) lines.push(`<div><strong style="color:#4fc3f7;">Robot:</strong> ${this.esc(status.robotAddress)}</div>`);
    if (status.remoteConnected) {
      const label = status.remoteName || status.remoteAddress;
      lines.push(`<div><strong style="color:#4fc3f7;">Remote:</strong> ${this.esc(label)}</div>`);
    }
    if (!connected) lines.push('<div style="color:#888;">Bluetooth: not connected</div>');
    this.tooltip.innerHTML = lines.join('');

    const changed = status.robotConnected !== this.lastStatus.robotConnected
      || status.remoteConnected !== this.lastStatus.remoteConnected
      || status.robotAddress !== this.lastStatus.robotAddress
      || status.remoteAddress !== this.lastStatus.remoteAddress;
    this.lastStatus = status;
    if (changed) {
      for (const cb of this.statusChangeListeners) cb(status);
    }
  }


  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.remove();
  }
}

// LiDAR icon SVGs (simple 3D scan/point cloud icon)
const LIDAR_SVG_ON = `<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#6879e4" stroke-width="2" stroke-linecap="round">
  <circle cx="12" cy="12" r="2"/>
  <path d="M12 2a10 10 0 0 1 0 20"/>
  <path d="M12 2a10 10 0 0 0 0 20"/>
  <path d="M12 6a6 6 0 0 1 0 12"/>
  <path d="M12 6a6 6 0 0 0 0 12"/>
</svg>`;

const LIDAR_SVG_OFF = `<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round">
  <circle cx="12" cy="12" r="2"/>
  <path d="M12 2a10 10 0 0 1 0 20"/>
  <path d="M12 2a10 10 0 0 0 0 20"/>
  <path d="M12 6a6 6 0 0 1 0 12"/>
  <path d="M12 6a6 6 0 0 0 0 12"/>
</svg>`;

// Relay Remote icon — classic gamepad silhouette with two sticks and a D-pad
const RELAY_SVG = (color: string) => `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <!-- Body shape (two rounded grips joined by central bridge) -->
  <path d="M7 8 C3 8, 2 13, 3 17 C3.5 19, 5 20, 7 19.5 L10 17 L16 17 L19 19.5 C21 20, 22.5 19, 23 17 C24 13, 23 8, 19 8 Z"/>
  <!-- Left stick -->
  <circle cx="8" cy="13" r="1.8" fill="${color}" stroke="none"/>
  <!-- Right stick -->
  <circle cx="18" cy="13" r="1.8" fill="${color}" stroke="none"/>
</svg>`;

// Waist-lock padlock icon (G1)
const WAIST_LOCK_SVG = (color: string) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="11" width="16" height="10" rx="2"/>
  <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
</svg>`;

import type { RobotFamily } from '../../api/unitree-cloud';

export interface SettingCallbacks {
  onRadarToggle: (enabled: boolean) => void;
  onLampSet: (level: number) => void;
  onVolumeSet: (level: number) => void;
  onLidarToggle: (enabled: boolean) => void;
  onRelayToggle: (enabled: boolean) => void;
  /** Optional Waist-Lock toggle — only rendered when handler is provided
   *  (G1 only). The flag indicates the desired locked state. */
  onWaistLockToggle?: (lock: boolean) => void;
  /** Robot family. G1 hides the Go2-specific buttons (Radar / LiDAR /
   *  Lamp) and shows a Waist Lock toggle in their place. */
  family?: RobotFamily;
}

export class SettingBar {
  private container: HTMLElement;
  private radarOn = false;
  private lidarOn = true;
  private radarBtn!: HTMLButtonElement;
  private volumeBtn!: HTMLButtonElement;
  private lampBtn!: HTMLButtonElement;
  private relayBtn!: HTMLButtonElement;
  private waistLockBtn: HTMLButtonElement | null = null;
  private waistLocked = false;
  private relayOn = false;
  private relayAvailable = false;
  private remoteName = '';
  private volumeLevel = 0;
  private lampLevel = 0;
  private callbacks: SettingCallbacks;

  constructor(parent: HTMLElement, callbacks: SettingCallbacks) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.container.className = 'setting-bar';

    const isG1 = callbacks.family === 'G1';

    // Radar / LiDAR / Lamp are quadruped-only controls (obstacle avoid,
    // mid360 toggle, head-lamp brightness). G1 has no equivalents in
    // the Explorer webview so we skip them.
    if (!isG1) {
      this.radarBtn = this.createBtn('/sprites/icon_radar.png', 'Radar');
      this.radarBtn.addEventListener('click', () => {
        this.radarOn = !this.radarOn;
        const img = this.radarBtn.querySelector('img')!;
        img.src = this.radarOn ? '/sprites/icon_radar_on.png' : '/sprites/icon_radar.png';
        callbacks.onRadarToggle(this.radarOn);
      });
      this.container.appendChild(this.radarBtn);

      const lidarBtn = this.createSvgBtn(LIDAR_SVG_ON, 'LiDAR');
      lidarBtn.addEventListener('click', () => {
        this.lidarOn = !this.lidarOn;
        lidarBtn.innerHTML = this.lidarOn ? LIDAR_SVG_ON : LIDAR_SVG_OFF;
        callbacks.onLidarToggle(this.lidarOn);
      });
      this.container.appendChild(lidarBtn);
    }

    // Volume button (kept on both families).
    this.volumeBtn = this.createBtn('/sprites/icon_volume.png', 'Volume');
    this.volumeBtn.addEventListener('click', () => {
      this.toggleSlider(this.volumeBtn, 'Vol', this.volumeLevel, (val) => {
        this.volumeLevel = val;
        const img = this.volumeBtn.querySelector('img')!;
        img.src = val > 0 ? '/sprites/icon_volume_on.png' : '/sprites/icon_volume.png';
        callbacks.onVolumeSet(val);
      });
    });
    this.container.appendChild(this.volumeBtn);

    if (!isG1) {
      this.lampBtn = this.createBtn('/sprites/icon_lamp.png', 'Light');
      this.lampBtn.addEventListener('click', () => {
        this.toggleSlider(this.lampBtn, 'Light', this.lampLevel, (val) => {
          this.lampLevel = val;
          const img = this.lampBtn.querySelector('img')!;
          img.src = val > 0 ? '/sprites/icon_lamp_on.png' : '/sprites/icon_lamp.png';
          callbacks.onLampSet(val);
        });
      });
      this.container.appendChild(this.lampBtn);
    }

    // Waist Lock — G1 only. Fires BaseRunner.G1_SETUP_MACHINE_TYPE
    // (script demarcate_setup_machine_type.sh) with arg "6" (lock) /
    // "5" (unlock) per the decompiled BaseInfoViewModel.kt:570.
    if (isG1 && callbacks.onWaistLockToggle) {
      this.waistLockBtn = this.createSvgBtn(WAIST_LOCK_SVG('#666'), 'Waist Unlocked');
      this.waistLockBtn.addEventListener('click', () => {
        this.waistLocked = !this.waistLocked;
        this.updateWaistLockVisual();
        callbacks.onWaistLockToggle?.(this.waistLocked);
      });
      this.container.appendChild(this.waistLockBtn);
    }

    // Relay Remote button (disabled until remote is connected)
    this.relayBtn = this.createSvgBtn(RELAY_SVG('#444'), 'Relay Remote');
    this.relayBtn.disabled = true;
    this.relayBtn.title = 'Connect a BLE remote to enable relay';
    this.relayBtn.style.cursor = 'not-allowed';
    this.relayBtn.style.opacity = '0.5';
    this.relayBtn.addEventListener('click', () => {
      if (!this.relayAvailable) return;
      this.relayOn = !this.relayOn;
      this.updateRelayVisual();
      callbacks.onRelayToggle(this.relayOn);
    });
    this.container.appendChild(this.relayBtn);

    parent.appendChild(this.container);
  }

  private updateWaistLockVisual(): void {
    if (!this.waistLockBtn) return;
    this.waistLockBtn.innerHTML = WAIST_LOCK_SVG(this.waistLocked ? '#6879e4' : '#666');
    const lbl = document.createElement('span');
    lbl.textContent = this.waistLocked ? 'Waist Locked' : 'Waist Unlocked';
    // createSvgBtn writes a <span> sibling to the <svg>. Replace it.
    const existingLbl = this.waistLockBtn.querySelector('span');
    if (existingLbl) existingLbl.textContent = lbl.textContent;
    else this.waistLockBtn.appendChild(lbl);
  }

  /** Called when BLE remote connection status changes. */
  setRelayAvailable(available: boolean, remoteName: string = ''): void {
    this.relayAvailable = available;
    this.remoteName = remoteName;
    if (!available && this.relayOn) {
      // Auto-disable relay if remote got disconnected
      this.relayOn = false;
      this.callbacks.onRelayToggle(false);
    }
    this.relayBtn.disabled = !available;
    this.relayBtn.style.cursor = available ? 'pointer' : 'not-allowed';
    this.relayBtn.style.opacity = available ? '1' : '0.5';
    this.updateRelayVisual();
  }

  private updateRelayVisual(): void {
    const color = !this.relayAvailable ? '#444' : (this.relayOn ? '#42CF55' : '#ccc');
    this.relayBtn.innerHTML = RELAY_SVG(color);

    let tooltip: string;
    if (!this.relayAvailable) {
      tooltip = 'Connect a BLE remote to enable relay';
    } else {
      const nameSuffix = this.remoteName ? ` (${this.remoteName})` : '';
      tooltip = this.relayOn
        ? `Relay ON — controlling robot via${nameSuffix}`
        : `Relay OFF — click to relay${nameSuffix}`;
    }
    this.relayBtn.title = tooltip;
  }

  setRadar(enabled: boolean): void {
    this.radarOn = enabled;
    const img = this.radarBtn.querySelector('img')!;
    img.src = enabled ? '/sprites/icon_radar_on.png' : '/sprites/icon_radar.png';
  }

  setVolume(level: number): void {
    this.volumeLevel = level;
    const img = this.volumeBtn.querySelector('img')!;
    img.src = level > 0 ? '/sprites/icon_volume_on.png' : '/sprites/icon_volume.png';
  }

  setBrightness(level: number): void {
    this.lampLevel = level;
    const img = this.lampBtn.querySelector('img')!;
    img.src = level > 0 ? '/sprites/icon_lamp_on.png' : '/sprites/icon_lamp.png';
  }

  private createBtn(iconSrc: string, alt: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'setting-btn';
    const img = document.createElement('img');
    img.src = iconSrc;
    img.alt = alt;
    img.draggable = false;
    btn.appendChild(img);
    return btn;
  }

  private createSvgBtn(svgHtml: string, _alt: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'setting-btn';
    btn.innerHTML = svgHtml;
    return btn;
  }

  private toggleSlider(
    anchor: HTMLElement,
    label: string,
    initialValue: number,
    onChange: (val: number) => void,
  ): void {
    const existing = anchor.querySelector('.slider-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'slider-popup';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.value = String(initialValue);

    const valueLabel = document.createElement('span');
    valueLabel.className = 'slider-value';
    valueLabel.textContent = `${label}: ${initialValue}`;

    range.addEventListener('input', () => {
      const val = parseInt(range.value, 10);
      valueLabel.textContent = `${label}: ${val}`;
      onChange(val);
    });

    popup.appendChild(range);
    popup.appendChild(valueLabel);
    anchor.style.position = 'relative';
    anchor.appendChild(popup);

    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        popup.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

/** APK-matching emergency stop: swipe the whole button left to activate. */
export class EmergencyStop {
  private container: HTMLElement;
  private arrowEl: HTMLElement;
  private activated = false;
  private startX = 0;
  private animating = false;

  constructor(parent: HTMLElement, private onStop: (active: boolean) => void) {
    this.container = document.createElement('div');
    this.container.className = 'emergency-stop';

    // Left-pointing double arrow
    this.arrowEl = document.createElement('span');
    this.arrowEl.className = 'estop-arrow';
    this.arrowEl.innerHTML = '&#x00AB;'; // « double left arrow

    const label = document.createElement('span');
    label.className = 'estop-label';
    label.textContent = 'STOP';

    this.container.appendChild(this.arrowEl);
    this.container.appendChild(label);

    // Invisible drag overlay (APK: operation_bar 120% width, 180% height)
    const dragArea = document.createElement('div');
    dragArea.className = 'estop-drag-area';
    this.container.appendChild(dragArea);

    dragArea.addEventListener('pointerdown', (e) => this.onPointerDown(e, dragArea));
    dragArea.addEventListener('pointermove', (e) => this.onPointerMove(e, dragArea));
    dragArea.addEventListener('pointerup', (e) => this.onPointerUp(e, dragArea));
    dragArea.addEventListener('pointercancel', (e) => this.onPointerUp(e, dragArea));

    parent.appendChild(this.container);
  }

  private onPointerDown(e: PointerEvent, area: HTMLElement): void {
    if (this.animating) return;
    this.startX = e.clientX;
    area.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent, area: HTMLElement): void {
    if (this.animating || !area.hasPointerCapture(e.pointerId)) return;
    // No visual movement — APK doesn't move the button visually during drag
  }

  private onPointerUp(e: PointerEvent, area: HTMLElement): void {
    if (this.animating) return;
    area.releasePointerCapture(e.pointerId);
    const dragDist = this.startX - e.clientX; // positive = dragged left

    if (!this.activated && dragDist > 30) {
      // Swipe left → activate
      this.activated = true;
      this.container.classList.add('animation');
      this.arrowEl.classList.add('active');
      this.onStop(true);
    } else if (this.activated && dragDist < -30) {
      // Swipe right → deactivate
      this.activated = false;
      this.container.classList.remove('animation');
      this.arrowEl.classList.remove('active');
      this.onStop(false);
    }
  }
}

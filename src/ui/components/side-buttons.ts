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

// Relay Remote icon — gamepad/joystick silhouette
const RELAY_SVG = (color: string) => `<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="8" width="20" height="10" rx="5"/>
  <line x1="7" y1="13" x2="9" y2="13"/>
  <line x1="8" y1="12" x2="8" y2="14"/>
  <circle cx="15" cy="12" r="0.8" fill="${color}"/>
  <circle cx="17" cy="14" r="0.8" fill="${color}"/>
</svg>`;

export interface SettingCallbacks {
  onRadarToggle: (enabled: boolean) => void;
  onLampSet: (level: number) => void;
  onVolumeSet: (level: number) => void;
  onLidarToggle: (enabled: boolean) => void;
  onRelayToggle: (enabled: boolean) => void;
}

export class SettingBar {
  private container: HTMLElement;
  private radarOn = false;
  private lidarOn = true;
  private radarBtn!: HTMLButtonElement;
  private volumeBtn!: HTMLButtonElement;
  private lampBtn!: HTMLButtonElement;
  private relayBtn!: HTMLButtonElement;
  private relayOn = false;
  private relayAvailable = false;
  private volumeLevel = 0;
  private lampLevel = 0;
  private callbacks: SettingCallbacks;

  constructor(parent: HTMLElement, callbacks: SettingCallbacks) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.container.className = 'setting-bar';

    // Radar button
    this.radarBtn = this.createBtn('/sprites/icon_radar.png', 'Radar');
    this.radarBtn.addEventListener('click', () => {
      this.radarOn = !this.radarOn;
      const img = this.radarBtn.querySelector('img')!;
      img.src = this.radarOn ? '/sprites/icon_radar_on.png' : '/sprites/icon_radar.png';
      callbacks.onRadarToggle(this.radarOn);
    });

    // LiDAR button
    const lidarBtn = this.createSvgBtn(LIDAR_SVG_ON, 'LiDAR');
    lidarBtn.addEventListener('click', () => {
      this.lidarOn = !this.lidarOn;
      lidarBtn.innerHTML = this.lidarOn ? LIDAR_SVG_ON : LIDAR_SVG_OFF;
      callbacks.onLidarToggle(this.lidarOn);
    });

    // Volume button
    this.volumeBtn = this.createBtn('/sprites/icon_volume.png', 'Volume');
    this.volumeBtn.addEventListener('click', () => {
      this.toggleSlider(this.volumeBtn, 'Vol', this.volumeLevel, (val) => {
        this.volumeLevel = val;
        const img = this.volumeBtn.querySelector('img')!;
        img.src = val > 0 ? '/sprites/icon_volume_on.png' : '/sprites/icon_volume.png';
        callbacks.onVolumeSet(val);
      });
    });

    // Lamp button
    this.lampBtn = this.createBtn('/sprites/icon_lamp.png', 'Light');
    this.lampBtn.addEventListener('click', () => {
      this.toggleSlider(this.lampBtn, 'Light', this.lampLevel, (val) => {
        this.lampLevel = val;
        const img = this.lampBtn.querySelector('img')!;
        img.src = val > 0 ? '/sprites/icon_lamp_on.png' : '/sprites/icon_lamp.png';
        callbacks.onLampSet(val);
      });
    });

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

    this.container.appendChild(this.radarBtn);
    this.container.appendChild(lidarBtn);
    this.container.appendChild(this.volumeBtn);
    this.container.appendChild(this.lampBtn);
    this.container.appendChild(this.relayBtn);

    parent.appendChild(this.container);
  }

  /** Called when BLE remote connection status changes. */
  setRelayAvailable(available: boolean): void {
    this.relayAvailable = available;
    if (!available && this.relayOn) {
      // Auto-disable relay if remote got disconnected
      this.relayOn = false;
      this.callbacks.onRelayToggle(false);
    }
    this.relayBtn.disabled = !available;
    this.relayBtn.style.cursor = available ? 'pointer' : 'not-allowed';
    this.relayBtn.style.opacity = available ? '1' : '0.5';
    this.relayBtn.title = available
      ? (this.relayOn ? 'Relay ON — BT remote is controlling the robot' : 'Relay OFF — click to enable')
      : 'Connect a BLE remote to enable relay';
    this.updateRelayVisual();
  }

  private updateRelayVisual(): void {
    const color = !this.relayAvailable ? '#444' : (this.relayOn ? '#42CF55' : '#888');
    this.relayBtn.innerHTML = RELAY_SVG(color);
    this.relayBtn.title = !this.relayAvailable
      ? 'Connect a BLE remote to enable relay'
      : (this.relayOn ? 'Relay ON — BT remote is controlling the robot' : 'Relay OFF — click to enable');
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

const BT_SVG = (color: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5L6.5 17.5"/>
</svg>`;

export class NavBar {
  private container: HTMLElement;
  private netTypeEl!: HTMLElement;
  private batteryFill!: HTMLElement;
  private batteryText!: HTMLElement;
  private motorTempEl!: HTMLElement;
  private btIconWrap!: HTMLElement;
  private onBack: () => void;
  private onBtIconClick: (() => void) | null = null;

  constructor(parent: HTMLElement, onBack: () => void) {
    this.onBack = onBack;

    this.container = document.createElement('div');
    this.container.className = 'nav-bar';
    this.build();
    parent.appendChild(this.container);
  }

  private build(): void {
    this.container.innerHTML = `
      <div class="nav-bar-left">
        <button class="back-btn">
          <img src="/sprites/nav-bar-left-icon.png" alt="Back" />
        </button>
        <span class="nav-bar-title">Go2</span>
      </div>
      <div class="nav-bar-right">
        <span class="motor-temp-label"></span>
        <div class="nav-divider"></div>
        <div class="battery-icon">
          <div class="battery-fill-box">
            <div class="battery-fill"></div>
            <span class="battery-text">--%</span>
          </div>
        </div>
        <div class="nav-divider"></div>
        <span class="net-type-label"></span>
        <img class="wifi-icon" src="/sprites/icon_wifi.png" alt="WiFi" />
        <div class="nav-bt-icon" title="Bluetooth: not connected"
             style="cursor:pointer;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:rgba(26,29,35,0.95);border:1.5px solid #3a3d45;margin-left:4px;transition:all 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${BT_SVG('#b0b3bb')}</div>
      </div>
    `;

    this.batteryFill = this.container.querySelector('.battery-fill')!;
    this.batteryText = this.container.querySelector('.battery-text')!;
    this.motorTempEl = this.container.querySelector('.motor-temp-label')!;
    this.netTypeEl = this.container.querySelector('.net-type-label')!;
    this.btIconWrap = this.container.querySelector('.nav-bt-icon')!;
    this.btIconWrap.addEventListener('click', () => { this.onBtIconClick?.(); });
    this.btIconWrap.addEventListener('mouseenter', () => {
      this.btIconWrap.style.background = 'rgba(79,195,247,0.2)';
      this.btIconWrap.style.transform = 'scale(1.05)';
    });
    this.btIconWrap.addEventListener('mouseleave', () => {
      this.btIconWrap.style.background = this.btIconWrap.dataset.connected === 'true' ? 'rgba(79,195,247,0.15)' : 'rgba(26,29,35,0.95)';
      this.btIconWrap.style.transform = 'scale(1)';
    });
    this.container.querySelector('.back-btn')!.addEventListener('click', this.onBack);
  }

  setBattery(percent: number): void {
    const p = Math.round(percent);
    this.batteryText.textContent = `${p}%`;
    this.batteryFill.style.width = `${p}%`;

    // APK color coding: red <=33%, yellow 34-66%, green 67%+
    let color: string;
    if (p <= 33) color = '#FF3D3D';
    else if (p <= 66) color = '#FCD335';
    else color = '#42CF55';
    this.batteryFill.style.backgroundColor = color;
  }

  setMotorTemp(maxTemp: number): void {
    const t = Math.round(maxTemp);
    this.motorTempEl.textContent = `${t}°C`;
    if (t > 70) this.motorTempEl.style.color = '#FF3D3D';
    else if (t > 50) this.motorTempEl.style.color = '#FCD335';
    else this.motorTempEl.style.color = '#aaa';
  }

  setNetworkType(type: string): void {
    this.netTypeEl.textContent = type;
  }

  setBluetoothStatus(connected: boolean, tooltip: string): void {
    const color = connected ? '#4fc3f7' : '#b0b3bb';
    this.btIconWrap.innerHTML = BT_SVG(color);
    this.btIconWrap.title = tooltip;
    this.btIconWrap.dataset.connected = connected ? 'true' : 'false';
    this.btIconWrap.style.borderColor = connected ? 'rgba(79,195,247,0.5)' : '#3a3d45';
    this.btIconWrap.style.background = connected ? 'rgba(79,195,247,0.15)' : 'rgba(26,29,35,0.95)';
  }

  setBtIconClick(handler: () => void): void {
    this.onBtIconClick = handler;
  }
}

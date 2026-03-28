export class NavBar {
  private container: HTMLElement;
  private netTypeEl!: HTMLElement;
  private batteryFill!: HTMLElement;
  private batteryText!: HTMLElement;
  private motorTempEl!: HTMLElement;
  private onBack: () => void;

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
        <div class="battery-icon">
          <div class="battery-fill-box">
            <div class="battery-fill"></div>
            <span class="battery-text">--%</span>
          </div>
        </div>
        <span class="motor-temp-label"></span>
      </div>
      <div class="nav-bar-right">
        <span class="net-type-label"></span>
        <img class="wifi-icon" src="/sprites/icon_wifi.png" alt="WiFi" />
      </div>
    `;

    this.batteryFill = this.container.querySelector('.battery-fill')!;
    this.batteryText = this.container.querySelector('.battery-text')!;
    this.motorTempEl = this.container.querySelector('.motor-temp-label')!;
    this.netTypeEl = this.container.querySelector('.net-type-label')!;
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
}

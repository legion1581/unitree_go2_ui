/**
 * BLE Configuration Page — scan, connect, view info, set WiFi
 * Communicates with Python BLE server via /ble-api/*
 */

const BLE_API = '/ble-api';

interface Robot {
  name: string;
  address: string;
  rssi: number | null;
  protocol: string;
}

interface BleStatus {
  connected: boolean;
  address: string;
  protocol: string;
}

export class BleConfigPage {
  private container: HTMLElement;
  private content: HTMLElement;
  private statusBar: HTMLElement;

  constructor(parent: HTMLElement, private onBack: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'status-page';

    // Header
    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', onBack);
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = 'Bluetooth Setup';
    header.appendChild(title);
    this.container.appendChild(header);

    // Status bar
    this.statusBar = document.createElement('div');
    this.statusBar.style.cssText = 'padding:8px 20px;font-size:12px;color:#888;background:rgba(15,17,20,0.95);border-bottom:1px solid #1a1d23;';
    this.statusBar.textContent = 'Checking BLE server...';
    this.container.appendChild(this.statusBar);

    // Content — constrained width for desktop
    this.content = document.createElement('div');
    this.content.className = 'page-content';
    this.content.style.cssText += 'max-width:520px;margin:0 auto;';
    this.container.appendChild(this.content);

    parent.appendChild(this.container);
    this.init();
  }

  private async init(): Promise<void> {
    try {
      const status = await this.fetchStatus();
      if (status.connected) {
        this.setStatus(`Connected to ${status.address} (${status.protocol})`, '#66bb6a');
        await this.showConnectedView(status);
      } else {
        this.setStatus('Not connected', '#888');
        await this.showScanView();
      }
    } catch {
      this.setStatus('BLE server not running. Start with: python3 server/ble_server.py', '#ef5350');
      this.showServerError();
    }
  }

  private setStatus(text: string, color = '#888'): void {
    this.statusBar.textContent = text;
    this.statusBar.style.color = color;
  }

  // ─── API helpers ────────────────────────────────────────────────

  private async fetchJSON<T>(path: string, opts?: RequestInit): Promise<T> {
    const resp = await fetch(`${BLE_API}${path}`, {
      ...opts,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const body = await resp.text();
      try { throw new Error(JSON.parse(body).detail || body); }
      catch { throw new Error(body); }
    }
    return resp.json();
  }

  private async fetchStatus(): Promise<BleStatus> {
    return this.fetchJSON('/status');
  }

  // ─── Server error view ────────────────────────────────────────

  private showServerError(): void {
    this.content.innerHTML = '';
    const s = this.section('BLE Server Required');
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;color:#aaa;line-height:1.6;';
    msg.innerHTML = `
      The Bluetooth configuration requires a Python backend server.<br><br>
      <span style="color:#4fc3f7;font-family:monospace;">pip install fastapi uvicorn bleak pycryptodome</span><br>
      <span style="color:#4fc3f7;font-family:monospace;">python3 server/ble_server.py</span><br><br>
      Then reload this page.
    `;
    s.appendChild(msg);
    const retryBtn = this.button('Retry', () => this.init());
    retryBtn.style.marginTop = '12px';
    s.appendChild(retryBtn);
    this.content.appendChild(s);
  }

  // ─── Scan view ─────────────────────────────────────────────────

  private async showScanView(): Promise<void> {
    this.content.innerHTML = '';

    // Adapter picker
    try {
      const data = await this.fetchJSON<{ adapters: Array<{ name: string; address: string; up: boolean; type: string }>; current: string }>('/adapters');
      if (data.adapters.length > 1) {
        const adapterSection = this.section('Bluetooth Adapter');
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        for (const a of data.adapters) {
          const btn = document.createElement('button');
          const isCurrent = a.name === data.current;
          btn.style.cssText = `padding:8px 14px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid ${isCurrent ? '#4fc3f7' : '#2a2d35'};background:${isCurrent ? 'rgba(79,195,247,0.1)' : '#0a0c10'};color:${isCurrent ? '#4fc3f7' : a.up ? '#aaa' : '#555'};`;
          btn.innerHTML = `<strong>${a.name}</strong><br><span style="font-size:10px;">${a.address}${a.type ? ' · ' + a.type : ''}${!a.up ? ' (down)' : ''}</span>`;
          if (!isCurrent) {
            btn.addEventListener('click', async () => {
              await this.fetchJSON(`/adapter?name=${encodeURIComponent(a.name)}`, { method: 'POST' });
              this.setStatus(`Switched to ${a.name}`, '#4fc3f7');
              await this.showScanView();
            });
          }
          row.appendChild(btn);
        }
        adapterSection.appendChild(row);
        this.content.appendChild(adapterSection);
      }
    } catch { /* no adapter info available, skip */ }

    // Scan
    const s = this.section('Scan for Robots');
    const scanBtn = this.button('Scan', () => this.doScan(scanBtn, resultsDiv));
    s.appendChild(scanBtn);
    const resultsDiv = document.createElement('div');
    resultsDiv.style.marginTop = '12px';
    s.appendChild(resultsDiv);
    this.content.appendChild(s);
  }

  private async doScan(btn: HTMLButtonElement, resultsDiv: HTMLElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    this.setStatus('Scanning for robots...', '#4fc3f7');
    resultsDiv.innerHTML = '';

    try {
      const data = await this.fetchJSON<{ robots: Robot[] }>('/scan?timeout=10');
      btn.disabled = false;
      btn.textContent = 'Scan';

      if (data.robots.length === 0) {
        resultsDiv.innerHTML = '<div style="color:#666;font-size:13px;">No robots found. Make sure the robot is powered on.</div>';
        this.setStatus('No robots found', '#888');
        return;
      }

      this.setStatus(`Found ${data.robots.length} robot(s)`, '#66bb6a');

      for (const robot of data.robots) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:6px;background:#0a0c10;border-radius:6px;border:1px solid #1f2229;cursor:pointer;';
        row.innerHTML = `
          <div style="flex:1;">
            <div style="font-weight:600;font-size:14px;">${this.esc(robot.name)}</div>
            <div style="font-size:11px;color:#666;font-family:monospace;">${this.esc(robot.address)} · RSSI: ${robot.rssi ?? '?'}</div>
          </div>
        `;
        const connectBtn = document.createElement('button');
        connectBtn.className = 'acct-btn acct-btn-primary';
        connectBtn.style.cssText = 'padding:6px 14px;font-size:12px;';
        connectBtn.textContent = 'Connect';
        connectBtn.addEventListener('click', (e) => { e.stopPropagation(); this.doConnect(robot.address, connectBtn); });
        row.appendChild(connectBtn);
        resultsDiv.appendChild(row);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Scan';
      this.setStatus(`Scan failed: ${e instanceof Error ? e.message : String(e)}`, '#ef5350');
    }
  }

  private async doConnect(address: string, connectBtn?: HTMLButtonElement): Promise<void> {
    if (!address) return;
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Connecting...'; }
    this.setStatus('Scanning for device...', '#4fc3f7');
    try {
      this.setStatus('Connecting to BLE device...', '#4fc3f7');
      await new Promise(r => setTimeout(r, 100)); // let UI update
      this.setStatus('Performing handshake...', '#4fc3f7');
      await this.fetchJSON('/connect?address=' + encodeURIComponent(address), { method: 'POST' });
      this.setStatus('Fetching robot info...', '#66bb6a');
      const status = await this.fetchStatus();
      this.setStatus(`Connected to ${status.address}`, '#66bb6a');
      await this.showConnectedView(status);
    } catch (e) {
      this.setStatus(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, '#ef5350');
      if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
    }
  }

  // ─── Connected view ────────────────────────────────────────────

  private async showConnectedView(status: BleStatus): Promise<void> {
    this.content.innerHTML = '';

    // Info section
    const infoSection = this.section('Robot Info');
    const infoContent = document.createElement('div');
    infoContent.style.cssText = 'color:#666;font-size:13px;';
    infoContent.textContent = 'Loading...';
    infoSection.appendChild(infoContent);
    this.content.appendChild(infoSection);

    // Fetch info
    try {
      const info = await this.fetchJSON<{ serial_number: string; ap_mac: string; protocol: string; address: string }>('/info');
      infoContent.innerHTML = '';
      this.infoRow(infoSection, 'Serial Number', info.serial_number || '—', true);
      this.infoRow(infoSection, 'AP MAC', info.ap_mac || '—', true);
      this.infoRow(infoSection, 'Address', info.address, true);
      this.infoRow(infoSection, 'Protocol', info.protocol);
    } catch (e) {
      infoContent.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      infoContent.style.color = '#ef5350';
    }

    // WiFi config section
    const wifiSection = this.section('WiFi Configuration');
    const form = document.createElement('div');
    form.className = 'acct-form';

    const ssidInput = this.input('SSID', 'text');
    const pwdInput = this.input('Password', 'password', 'password');
    const countryInput = this.input('Country Code', 'text');
    countryInput.input.value = 'US';

    // Mode toggle
    const modeLabel = document.createElement('div');
    modeLabel.style.cssText = 'font-size:11px;color:#666;margin-bottom:6px;';
    modeLabel.textContent = 'WiFi Mode';
    form.appendChild(modeLabel);

    const modeWrap = document.createElement('div');
    modeWrap.style.cssText = 'display:flex;gap:0;margin-bottom:14px;border-radius:8px;overflow:hidden;border:1px solid #2a2d35;';
    let apMode = false;

    const staBtn = document.createElement('button');
    const apBtn = document.createElement('button');
    const modeStyle = (active: boolean) => `flex:1;padding:10px 8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.15s;${
      active ? 'background:#4fc3f7;color:#000;' : 'background:#0a0c10;color:#666;'
    }`;

    staBtn.style.cssText = modeStyle(true);
    staBtn.innerHTML = '<div>STA</div><div style="font-size:10px;font-weight:400;margin-top:2px;">Join existing WiFi</div>';
    apBtn.style.cssText = modeStyle(false);
    apBtn.innerHTML = '<div>AP</div><div style="font-size:10px;font-weight:400;margin-top:2px;">Create hotspot</div>';

    staBtn.addEventListener('click', () => { apMode = false; staBtn.style.cssText = modeStyle(true); apBtn.style.cssText = modeStyle(false); });
    apBtn.addEventListener('click', () => { apMode = true; apBtn.style.cssText = modeStyle(true); staBtn.style.cssText = modeStyle(false); });

    modeWrap.appendChild(staBtn);
    modeWrap.appendChild(apBtn);
    form.appendChild(modeWrap);
    form.appendChild(ssidInput.wrapper);
    form.appendChild(pwdInput.wrapper);
    form.appendChild(countryInput.wrapper);

    const wifiStatus = document.createElement('div');
    wifiStatus.style.cssText = 'font-size:12px;min-height:18px;margin-top:4px;';

    const applyBtn = this.button('Apply WiFi Settings', async () => {
      const ssid = ssidInput.input.value.trim();
      const pwd = pwdInput.input.value;
      if (!ssid) { wifiStatus.textContent = 'SSID required'; wifiStatus.style.color = '#ef5350'; return; }

      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying...';
      wifiStatus.textContent = 'Sending configuration...';
      wifiStatus.style.color = '#4fc3f7';

      try {
        const resp = await this.fetchJSON<{ success: boolean; details: Record<string, boolean> }>('/wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password: pwd, ap_mode: apMode, country: countryInput.input.value.trim() }),
        });

        if (resp.success) {
          wifiStatus.textContent = 'WiFi configured successfully!';
          wifiStatus.style.color = '#66bb6a';
        } else {
          const failed = Object.entries(resp.details).filter(([, v]) => !v).map(([k]) => k).join(', ');
          wifiStatus.textContent = `Partially failed: ${failed}`;
          wifiStatus.style.color = '#ff9800';
        }
      } catch (e) {
        wifiStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
        wifiStatus.style.color = '#ef5350';
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply WiFi Settings';
      }
    });

    form.appendChild(applyBtn);
    form.appendChild(wifiStatus);
    wifiSection.appendChild(form);
    this.content.appendChild(wifiSection);

    // Disconnect
    const disconnectSection = this.section('Connection');
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'acct-btn acct-btn-danger';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', async () => {
      await this.fetchJSON('/disconnect', { method: 'POST' });
      this.setStatus('Disconnected', '#888');
      this.showScanView();
    });
    disconnectSection.appendChild(disconnectBtn);
    this.content.appendChild(disconnectSection);
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private section(title: string): HTMLElement {
    const s = document.createElement('div');
    s.className = 'status-section';
    const t = document.createElement('div');
    t.className = 'status-section-title';
    t.textContent = title;
    s.appendChild(t);
    return s;
  }

  private infoRow(parent: HTMLElement, label: string, value: string, mono = false): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:3px 0;font-size:13px;align-items:center;';
    row.innerHTML = `<span style="color:#888;min-width:100px;">${this.esc(label)}</span><span style="${mono ? 'font-family:monospace;font-size:12px;' : ''}color:#e0e0e0;user-select:text;">${this.esc(value)}</span>`;
    parent.appendChild(row);
  }

  private input(label: string, type: string, inputType?: string): { wrapper: HTMLElement; input: HTMLInputElement } {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '10px';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:11px;color:#666;margin-bottom:3px;';
    lbl.textContent = label;
    wrapper.appendChild(lbl);
    const input = document.createElement('input');
    input.type = inputType || type;
    input.style.cssText = 'width:100%;padding:8px 10px;background:#0a0c10;border:1px solid #2a2d35;color:#e0e0e0;border-radius:6px;font-size:14px;';
    wrapper.appendChild(input);
    return { wrapper, input };
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'acct-btn acct-btn-primary';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  destroy(): void {
    this.container.remove();
  }
}

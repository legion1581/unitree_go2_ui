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

interface Remote {
  name: string;
  address: string;
  rssi: number | null;
}

interface BleStatus {
  connected: boolean;
  address: string;
  protocol: string;
}

interface RemoteState {
  lx: number; ly: number; rx: number; ry: number;
  buttons: Record<string, boolean>;
  battery: number;
  rssi: number;
}

export class BleConfigPage {
  private container: HTMLElement;
  private content: HTMLElement;
  private statusBar: HTMLElement;
  private statusIndicator: HTMLElement | null = null;
  private remotePollTimer: ReturnType<typeof setInterval> | null = null;

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

    // Status bar (hidden, used internally for status tracking)
    this.statusBar = document.createElement('div');
    this.statusBar.style.cssText = 'display:none;';
    this.container.appendChild(this.statusBar);

    // Content — full width
    this.content = document.createElement('div');
    this.content.className = 'page-content';
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
    if (this.remotePollTimer) { clearInterval(this.remotePollTimer); this.remotePollTimer = null; }
    this.content.innerHTML = '';

    // Status section (centered, first)
    const statusSection = this.section('Status');
    this.statusIndicator = document.createElement('div');
    this.statusIndicator.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#888;';
    this.statusIndicator.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;"></span> Not connected`;
    statusSection.appendChild(this.statusIndicator);
    this.content.appendChild(statusSection);

    // Adapter picker
    try {
      const data = await this.fetchJSON<{ adapters: Array<{ name: string; address: string; up: boolean; type: string }>; current: string }>('/adapters');
      const adapterSection = this.section('Bluetooth Adapter');
      if (data.adapters.length === 0) {
        const noAdapter = document.createElement('div');
        noAdapter.style.cssText = 'font-size:13px;color:#666;';
        noAdapter.textContent = 'No Bluetooth adapters found';
        adapterSection.appendChild(noAdapter);
      } else {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        for (const a of data.adapters) {
          const btn = document.createElement('button');
          const isCurrent = a.name === data.current;
          btn.style.cssText = `padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer;text-align:center;min-width:0;border:1px solid ${isCurrent ? '#4fc3f7' : '#2a2d35'};background:${isCurrent ? 'rgba(79,195,247,0.1)' : '#0a0c10'};color:${isCurrent ? '#4fc3f7' : a.up ? '#aaa' : '#555'};`;
          btn.innerHTML = `<strong>${a.name}</strong><br><span style="font-size:10px;white-space:nowrap;">${a.address}${a.type ? ' · ' + a.type : ''} (${a.up ? 'up' : 'down'})</span>`;
          if (!isCurrent) {
            btn.addEventListener('click', async () => {
              await this.fetchJSON(`/adapter?name=${encodeURIComponent(a.name)}`, { method: 'POST' });
              await this.showScanView();
            });
          }
          row.appendChild(btn);
        }
        adapterSection.appendChild(row);
      }
      this.content.appendChild(adapterSection);
    } catch { /* no adapter info available, skip */ }

    // Scan
    const s = this.section('Scan for Devices');
    const scanBtn = this.button('Scan', () => this.doScan(scanBtn, resultsDiv));
    s.appendChild(scanBtn);
    const resultsDiv = document.createElement('div');
    resultsDiv.style.marginTop = '12px';
    s.appendChild(resultsDiv);
    this.content.appendChild(s);

    // Remote live view (if already connected)
    try {
      const rs = await this.fetchJSON<{ connected: boolean; address: string; name: string }>('/remote/status');
      if (rs.connected) {
        const remoteSection = this.section('Remote Control');
        this.showRemoteLiveView(remoteSection, rs.address, rs.name);
        this.content.appendChild(remoteSection);
      }
    } catch { /* ignore */ }
  }

  private async doScan(btn: HTMLButtonElement, resultsDiv: HTMLElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    this.updateIndicator('Scanning...', '#4fc3f7', true);
    resultsDiv.innerHTML = '';

    try {
      const data = await this.fetchJSON<{ robots: Robot[]; remotes: Remote[] }>('/scan?timeout=10');
      btn.disabled = false;
      btn.textContent = 'Scan';

      const total = data.robots.length + data.remotes.length;
      if (total === 0) {
        resultsDiv.innerHTML = '<div style="color:#666;font-size:13px;">No devices found. Make sure the robot is powered on.</div>';
        this.updateIndicator('Not connected', '#888');
        return;
      }

      this.updateIndicator(`Found ${data.robots.length} robot(s), ${data.remotes.length} remote(s)`, '#66bb6a');

      for (const robot of data.robots) {
        resultsDiv.appendChild(this.deviceRow(
          '\u{1F916}', robot.name, robot.address, robot.rssi,
          'Robot', (cb) => this.doConnect(robot.address, cb),
        ));
      }

      for (const remote of data.remotes) {
        resultsDiv.appendChild(this.deviceRow(
          '\u{1F3AE}', remote.name, remote.address, remote.rssi,
          'Remote', (cb) => this.doConnectRemote(remote.address, cb),
        ));
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Scan';
      this.updateIndicator(`Scan failed: ${e instanceof Error ? e.message : String(e)}`, '#ef5350');
    }
  }

  private deviceRow(icon: string, name: string, address: string, rssi: number | null, type: string, onConnect: (btn: HTMLButtonElement) => void): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;margin-bottom:6px;background:#0a0c10;border-radius:6px;border:1px solid #1f2229;';
    row.innerHTML = `
      <div style="font-size:22px;width:32px;text-align:center;flex-shrink:0;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;">${this.esc(name)} <span style="font-size:10px;color:#666;font-weight:400;">${this.esc(type)}</span></div>
        <div style="font-size:11px;color:#666;font-family:monospace;">${this.esc(address)} · RSSI: ${rssi ?? '?'}</div>
      </div>
    `;
    const connectBtn = document.createElement('button');
    connectBtn.className = 'acct-btn acct-btn-primary';
    connectBtn.style.cssText = 'padding:6px 14px;font-size:12px;flex-shrink:0;';
    connectBtn.textContent = 'Connect';
    connectBtn.addEventListener('click', (e) => { e.stopPropagation(); onConnect(connectBtn); });
    row.appendChild(connectBtn);
    return row;
  }

  private async doConnect(address: string, connectBtn?: HTMLButtonElement): Promise<void> {
    if (!address) return;
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Connecting...'; }

    try {
      this.updateIndicator(`Connecting to ${address}...`, '#4fc3f7', true);
      await this.fetchJSON('/connect?address=' + encodeURIComponent(address), { method: 'POST' });
      this.updateIndicator(`Connected — fetching info...`, '#4fc3f7', true);
      const status = await this.fetchStatus();
      this.updateIndicator(`Connected to ${status.address} (${status.protocol})`, '#66bb6a');
      await this.showConnectedView(status);
    } catch (e) {
      this.updateIndicator(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, '#ef5350');
      if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
    }
  }

  private async doConnectRemote(address: string, connectBtn?: HTMLButtonElement): Promise<void> {
    if (!address) return;
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Connecting...'; }

    try {
      this.updateIndicator(`Connecting remote ${address}...`, '#4fc3f7', true);
      const resp = await this.fetchJSON<{ connected: boolean; name: string }>('/remote/connect?address=' + encodeURIComponent(address), { method: 'POST' });
      this.updateIndicator(`Remote connected: ${resp.name}`, '#66bb6a');
      // Refresh the page to show live view
      await this.showScanView();
    } catch (e) {
      this.updateIndicator(`Remote connection failed: ${e instanceof Error ? e.message : String(e)}`, '#ef5350');
      if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
    }
  }

  private showRemoteLiveView(parent: HTMLElement, address: string, name: string): void {
    // Header: name, address, Hz, battery
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:6px;';
    header.innerHTML = `
      <div style="font-size:13px;color:#66bb6a;"><strong>${this.esc(name)}</strong> <span style="color:#666;font-family:monospace;font-size:11px;">${this.esc(address)}</span></div>
    `;
    const metaDiv = document.createElement('div');
    metaDiv.style.cssText = 'font-size:11px;color:#666;font-family:monospace;';
    header.appendChild(metaDiv);
    parent.appendChild(header);

    // Controller body
    const ctrl = document.createElement('div');
    ctrl.style.cssText = 'background:#0a0c10;border-radius:16px;border:1px solid #1f2229;padding:14px;max-width:460px;margin:0 auto;';
    parent.appendChild(ctrl);

    // ── Shoulder buttons: L2 L1 ... R1 R2
    const shoulders = document.createElement('div');
    shoulders.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:10px;';
    const shoulderL = document.createElement('div');
    shoulderL.style.cssText = 'display:flex;gap:6px;';
    const shoulderR = document.createElement('div');
    shoulderR.style.cssText = 'display:flex;gap:6px;';
    shoulders.appendChild(shoulderL);
    shoulders.appendChild(shoulderR);
    ctrl.appendChild(shoulders);

    const btnEls: Record<string, HTMLElement> = {};
    const mkBtn = (label: string, w = 'auto') => {
      const el = document.createElement('div');
      el.style.cssText = `padding:4px 10px;border-radius:5px;font-size:11px;font-family:monospace;text-align:center;min-width:${w};border:1px solid #1f2229;background:#111318;color:#555;transition:all 0.05s;user-select:none;`;
      el.textContent = label;
      btnEls[label] = el;
      return el;
    };

    shoulderL.appendChild(mkBtn('L2', '32px'));
    shoulderL.appendChild(mkBtn('L1', '32px'));
    shoulderR.appendChild(mkBtn('R1', '32px'));
    shoulderR.appendChild(mkBtn('R2', '32px'));

    // ── Joysticks row
    const stickRow = document.createElement('div');
    stickRow.style.cssText = 'display:flex;justify-content:space-around;align-items:center;margin:8px 0;';
    ctrl.appendChild(stickRow);

    const makeStick = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      canvas.style.cssText = 'border-radius:50%;background:#080a0e;border:1px solid #1a1d23;';
      return canvas;
    };
    const leftCanvas = makeStick();
    const rightCanvas = makeStick();
    stickRow.appendChild(leftCanvas);
    stickRow.appendChild(rightCanvas);

    // ── D-pad + Face buttons row
    const faceRow = document.createElement('div');
    faceRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:10px 0;';
    ctrl.appendChild(faceRow);

    // D-pad (cross layout)
    const dpad = document.createElement('div');
    dpad.style.cssText = 'display:grid;grid-template-columns:28px 28px 28px;grid-template-rows:28px 28px 28px;gap:2px;justify-items:center;align-items:center;';
    const empty = () => document.createElement('div');
    dpad.append(empty(), mkBtn('Up', '28px'), empty(), mkBtn('Left', '28px'), empty(), mkBtn('Right', '28px'), empty(), mkBtn('Down', '28px'), empty());
    faceRow.appendChild(dpad);

    // ABXY diamond
    const abxy = document.createElement('div');
    abxy.style.cssText = 'display:grid;grid-template-columns:32px 32px 32px;grid-template-rows:28px 28px 28px;gap:2px;justify-items:center;align-items:center;';
    abxy.append(empty(), mkBtn('Y', '32px'), empty(), mkBtn('X', '32px'), empty(), mkBtn('B', '32px'), empty(), mkBtn('A', '32px'), empty());
    faceRow.appendChild(abxy);

    // ── Bottom row: F1 Select ... F2 Start
    const bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display:flex;justify-content:space-between;margin-top:10px;';
    const bottomL = document.createElement('div');
    bottomL.style.cssText = 'display:flex;gap:6px;';
    const bottomR = document.createElement('div');
    bottomR.style.cssText = 'display:flex;gap:6px;';
    bottomL.appendChild(mkBtn('F1'));
    bottomL.appendChild(mkBtn('Select'));
    bottomR.appendChild(mkBtn('F2'));
    bottomR.appendChild(mkBtn('Start'));
    bottomRow.appendChild(bottomL);
    bottomRow.appendChild(bottomR);
    ctrl.appendChild(bottomRow);

    // ── Stick value text
    const stickInfo = document.createElement('div');
    stickInfo.style.cssText = 'text-align:center;font-size:10px;color:#555;font-family:monospace;margin-top:8px;';
    ctrl.appendChild(stickInfo);

    // ── Drawing helpers
    const drawStick = (canvas: HTMLCanvasElement, x: number, y: number) => {
      const ctx = canvas.getContext('2d')!;
      const s = canvas.width, cx = s / 2, cy = s / 2, r = s * 0.37;
      ctx.clearRect(0, 0, s, s);
      ctx.strokeStyle = '#1a1d23';
      ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, s - 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4, cy); ctx.lineTo(s - 4, cy); ctx.stroke();
      ctx.strokeStyle = '#2a2d35';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#4fc3f7';
      ctx.beginPath(); ctx.arc(cx + x * r, cy - y * r, 6, 0, Math.PI * 2); ctx.fill();
    };

    const setBtn = (name: string, pressed: boolean) => {
      const el = btnEls[name];
      if (!el) return;
      el.style.borderColor = pressed ? '#4fc3f7' : '#1f2229';
      el.style.background = pressed ? 'rgba(79,195,247,0.15)' : '#111318';
      el.style.color = pressed ? '#4fc3f7' : '#555';
    };

    // ── Hz counter
    let frameCount = 0;
    let lastHzTime = performance.now();
    let hz = 0;

    const updateState = async () => {
      try {
        const state = await this.fetchJSON<RemoteState>('/remote/state');

        // Hz
        frameCount++;
        const now = performance.now();
        if (now - lastHzTime >= 1000) {
          hz = Math.round(frameCount * 1000 / (now - lastHzTime));
          frameCount = 0;
          lastHzTime = now;
        }

        drawStick(leftCanvas, state.lx, state.ly);
        drawStick(rightCanvas, state.rx, state.ry);

        for (const [bname, pressed] of Object.entries(state.buttons)) {
          setBtn(bname, pressed);
        }

        stickInfo.textContent = `LX:${state.lx.toFixed(2)} LY:${state.ly.toFixed(2)}  RX:${state.rx.toFixed(2)} RY:${state.ry.toFixed(2)}`;
        metaDiv.textContent = `${hz} Hz · Bat: ${state.battery}% · RSSI: ${state.rssi}`;
      } catch { /* ignore poll errors */ }
    };

    updateState();
    this.remotePollTimer = setInterval(updateState, 50);

    // Disconnect button
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'acct-btn acct-btn-danger';
    disconnectBtn.style.marginTop = '12px';
    disconnectBtn.textContent = 'Disconnect Remote';
    disconnectBtn.addEventListener('click', async () => {
      if (this.remotePollTimer) { clearInterval(this.remotePollTimer); this.remotePollTimer = null; }
      try { await this.fetchJSON('/remote/disconnect', { method: 'POST' }); } catch { /* force disconnect regardless */ }
      await this.showScanView();
    });
    parent.appendChild(disconnectBtn);
  }

  private updateIndicator(text: string, color: string, animating = false): void {
    if (!this.statusIndicator) return;
    const dot = animating
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};animation:pulse 1s infinite;"></span>`
      : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>`;
    this.statusIndicator.style.color = color;
    this.statusIndicator.innerHTML = `${dot} ${this.esc(text)}`;
  }

  // ─── Connected view ────────────────────────────────────────────

  private async showConnectedView(status: BleStatus): Promise<void> {
    this.content.innerHTML = '';

    // Status section (centered, first)
    const statusSection = this.section('Status');
    this.statusIndicator = document.createElement('div');
    this.statusIndicator.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;color:#66bb6a;';
    this.statusIndicator.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#66bb6a;"></span> Connected to ${this.esc(status.address)} (${this.esc(status.protocol)})`;
    statusSection.appendChild(this.statusIndicator);
    this.content.appendChild(statusSection);

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
    input.style.cssText = 'width:100%;padding:8px 10px;background:#0a0c10;border:1px solid #2a2d35;color:#e0e0e0;border-radius:6px;font-size:14px;box-sizing:border-box;';
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
    if (this.remotePollTimer) { clearInterval(this.remotePollTimer); this.remotePollTimer = null; }
    this.container.remove();
  }
}

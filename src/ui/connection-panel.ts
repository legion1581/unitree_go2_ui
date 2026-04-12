import type { ConnectionMode, ConnectionConfig } from '../types';
import { MODE_LABELS, DEFAULT_AP_IP } from '../connection/modes';
import { scanForRobots } from '../connection/network-scan';
import { cloudApi, type RobotDevice } from '../api/unitree-cloud';

export type ConnectHandler = (config: ConnectionConfig) => void;

/**
 * Remote mode flow:
 *   1. Show email/password (or token) → Login button
 *   2. On login success → fetch device list → show robot picker
 *   3. Auto-select if single robot → Connect button
 */
export class ConnectionPanel {
  private container: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private ipInput!: HTMLInputElement;
  private emailInput!: HTMLInputElement;
  private passwordInput!: HTMLInputElement;
  private tokenInput!: HTMLInputElement;
  private connectBtn!: HTMLButtonElement;
  private scanBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private authToggle!: HTMLElement;
  private robotPickerGroup!: HTMLElement;
  private robotSelect!: HTMLSelectElement;
  private loginBtn!: HTMLButtonElement;
  private useToken = false;
  private remoteLoggedIn = false;
  private selectedSn = '';
  private onConnect: ConnectHandler;

  constructor(parent: HTMLElement, onConnect: ConnectHandler) {
    this.container = document.createElement('div');
    this.container.className = 'connection-panel';
    this.onConnect = onConnect;
    this.build();
    parent.appendChild(this.container);
  }

  private build(): void {
    this.container.innerHTML = `
      <h2>Connect to Go2</h2>
      <div class="form-group">
        <label for="mode-select">Connection Mode</label>
        <select id="mode-select"></select>
      </div>
      <div class="form-group" id="ip-group">
        <label for="ip-input">Robot IP Address</label>
        <div class="ip-row">
          <input type="text" id="ip-input" placeholder="192.168.12.1" />
          <button id="scan-btn" class="btn-scan" title="Scan network">Scan</button>
        </div>
      </div>
      <div id="auth-toggle" class="form-group" style="display:none">
        <div class="auth-toggle-row">
          <button class="auth-tab active" data-auth="credentials">Email / Password</button>
          <button class="auth-tab" data-auth="token">Token</button>
        </div>
      </div>
      <div class="form-group" id="email-group">
        <label for="email-input">Email</label>
        <input type="email" id="email-input" placeholder="Unitree account email" />
      </div>
      <div class="form-group" id="password-group">
        <label for="password-input">Password</label>
        <input type="password" id="password-input" placeholder="Account password" />
      </div>
      <div class="form-group" id="token-group">
        <label for="token-input">Access Token</label>
        <input type="text" id="token-input" placeholder="Paste access token" />
      </div>
      <button id="login-btn" class="btn-connect" style="display:none">Login</button>
      <div class="form-group" id="robot-picker-group" style="display:none">
        <label>Choose Robot for WebView</label>
        <select id="robot-select"><option value="">-- Select robot --</option></select>
      </div>
      <button id="connect-btn" class="btn-connect">Connect</button>
      <div id="connection-status" class="status"></div>
    `;

    this.modeSelect = this.container.querySelector('#mode-select')!;
    this.ipInput = this.container.querySelector('#ip-input')!;
    this.emailInput = this.container.querySelector('#email-input')!;
    this.passwordInput = this.container.querySelector('#password-input')!;
    this.tokenInput = this.container.querySelector('#token-input')!;
    this.connectBtn = this.container.querySelector('#connect-btn')!;
    this.loginBtn = this.container.querySelector('#login-btn')!;
    this.scanBtn = this.container.querySelector('#scan-btn')!;
    this.statusEl = this.container.querySelector('#connection-status')!;
    this.authToggle = this.container.querySelector('#auth-toggle')!;
    this.robotPickerGroup = this.container.querySelector('#robot-picker-group')!;
    this.robotSelect = this.container.querySelector('#robot-select')!;

    for (const [mode, label] of Object.entries(MODE_LABELS)) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }

    this.authToggle.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.useToken = (tab as HTMLElement).dataset.auth === 'token';
        this.updateVisibility();
      });
    });

    this.modeSelect.addEventListener('change', () => {
      this.remoteLoggedIn = false;
      this.updateVisibility();
    });
    this.connectBtn.addEventListener('click', () => this.handleConnect());
    this.loginBtn.addEventListener('click', () => this.handleRemoteLogin());
    this.scanBtn.addEventListener('click', () => this.handleScan());
    this.robotSelect.addEventListener('change', () => {
      this.selectedSn = this.robotSelect.value;
    });

    this.modeSelect.value = 'STA-L';
    this.updateVisibility();

    // If already logged in from a previous session, pre-load robots
    if (cloudApi.loadSession() && cloudApi.isLoggedIn) {
      // Don't auto-show yet — wait until user selects Remote mode
    }
  }

  private updateVisibility(): void {
    const mode = this.modeSelect.value as ConnectionMode;
    const isRemote = mode === 'STA-T';

    const ipGroup = this.container.querySelector('#ip-group') as HTMLElement;
    const emailGroup = this.container.querySelector('#email-group') as HTMLElement;
    const passwordGroup = this.container.querySelector('#password-group') as HTMLElement;
    const tokenGroup = this.container.querySelector('#token-group') as HTMLElement;

    // Local modes: show IP input
    ipGroup.style.display = isRemote ? 'none' : '';

    // Remote mode: show auth OR robot picker (depending on login state)
    this.authToggle.style.display = isRemote && !this.remoteLoggedIn ? '' : 'none';

    if (isRemote && !this.remoteLoggedIn) {
      // Show login form
      this.authToggle.querySelectorAll('.auth-tab').forEach((tab) => {
        const isTokenTab = (tab as HTMLElement).dataset.auth === 'token';
        tab.classList.toggle('active', this.useToken ? isTokenTab : !isTokenTab);
      });
      emailGroup.style.display = this.useToken ? 'none' : '';
      passwordGroup.style.display = this.useToken ? 'none' : '';
      tokenGroup.style.display = this.useToken ? '' : 'none';
      this.loginBtn.style.display = '';
      this.connectBtn.style.display = 'none';
      this.robotPickerGroup.style.display = 'none';
    } else {
      // Local mode
      emailGroup.style.display = 'none';
      passwordGroup.style.display = 'none';
      tokenGroup.style.display = 'none';
      this.loginBtn.style.display = 'none';
      this.connectBtn.style.display = '';
      this.robotPickerGroup.style.display = 'none';
    }

    if (mode === 'AP') {
      this.ipInput.value = DEFAULT_AP_IP;
      this.ipInput.readOnly = true;
    } else {
      this.ipInput.readOnly = false;
      if (this.ipInput.value === DEFAULT_AP_IP && mode === 'STA-L') {
        this.ipInput.value = '';
        this.ipInput.placeholder = 'Robot IP on local network';
      }
    }
  }

  private async handleRemoteLogin(): Promise<void> {
    this.loginBtn.disabled = true;
    this.loginBtn.textContent = 'Logging in...';
    this.setStatus('', 'info');

    try {
      if (this.useToken) {
        const token = this.tokenInput.value.trim();
        if (!token) throw new Error('Paste an access token');
        cloudApi.setAccessToken(token);
        cloudApi.saveSession();
      } else {
        const email = this.emailInput.value.trim();
        const pwd = this.passwordInput.value.trim();
        if (!email || !pwd) throw new Error('Enter email and password');
        await cloudApi.loginEmail(email, pwd);
      }

      this.setStatus('Loading your robots...', 'info');
      const devices = await cloudApi.listDevices();

      // Cache for hub screen
      try { localStorage.setItem('unitree_devices_cache', JSON.stringify(devices)); } catch { /* ignore */ }

      if (devices.length === 0) {
        this.setStatus('No robots bound to your account', 'error');
        this.loginBtn.disabled = false;
        this.loginBtn.textContent = 'Login';
        return;
      }

      // Auto-select first robot and go straight to hub
      const firstSn = devices[0].sn;
      this.onConnect({
        mode: 'STA-T',
        ip: '',
        token: cloudApi.accessToken,
        serialNumber: firstSn,
        email: '',
        password: '',
      });
    } catch (e) {
      this.setStatus(`Login failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.loginBtn.disabled = false;
      this.loginBtn.textContent = 'Login';
    }
  }

  private handleConnect(): void {
    const mode = this.modeSelect.value as ConnectionMode;

    if (mode === 'STA-T') {
      // For Remote mode, go to hub (WebRTC connect happens there)
      const sn = this.selectedSn || this.robotSelect.value;
      if (!sn) {
        this.setStatus('Please select a robot', 'error');
        return;
      }
      // Pass config WITHOUT triggering WebRTC — hub handles that
      this.onConnect({
        mode,
        ip: '',
        token: cloudApi.accessToken,
        serialNumber: sn,
        email: '',
        password: '',
      });
    } else {
      this.onConnect({
        mode,
        ip: this.ipInput.value.trim(),
        token: '',
        serialNumber: '',
        email: '',
        password: '',
      });
    }
  }

  private async handleScan(): Promise<void> {
    this.scanBtn.disabled = true;
    this.scanBtn.textContent = '...';
    this.setStatus('Scanning network...', 'info');

    try {
      const results = await scanForRobots((msg) => this.setStatus(msg, 'info'));
      if (results.length > 0) {
        const best = results[0];
        this.ipInput.value = best.ip;
        if (best.ip !== DEFAULT_AP_IP) {
          this.modeSelect.value = 'STA-L';
          this.updateVisibility();
        }
        this.setStatus(`Found robot at ${best.ip} (SN: ${best.sn || 'unknown'})`, 'success');
      } else {
        this.setStatus('No robots found on network', 'error');
      }
    } catch (err) {
      this.setStatus('Scan failed: ' + (err instanceof Error ? err.message : 'unknown'), 'error');
    } finally {
      this.scanBtn.disabled = false;
      this.scanBtn.textContent = 'Scan';
    }
  }

  setStatus(text: string, type: 'info' | 'success' | 'error' = 'info'): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `status status-${type}`;
  }

  setConnecting(connecting: boolean): void {
    this.connectBtn.disabled = connecting;
    this.connectBtn.textContent = connecting ? 'Connecting...' : 'Connect';
  }

  setConnected(connected: boolean): void {
    this.connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
    this.connectBtn.disabled = false;
  }
}

import type { ConnectionMode, ConnectionConfig } from '../types';
import { MODE_LABELS, DEFAULT_AP_IP } from '../connection/modes';
import { scanForRobots } from '../connection/network-scan';
import { cloudApi, type RobotDevice } from '../api/unitree-cloud';

export type ConnectHandler = (config: ConnectionConfig) => void;

export class ConnectionPanel {
  private container: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private ipInput!: HTMLInputElement;
  private snInput!: HTMLInputElement;
  private snSelect!: HTMLSelectElement;
  private loadRobotsBtn!: HTMLButtonElement;
  private emailInput!: HTMLInputElement;
  private passwordInput!: HTMLInputElement;
  private tokenInput!: HTMLInputElement;
  private connectBtn!: HTMLButtonElement;
  private scanBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private authToggle!: HTMLElement;
  private useToken = false;
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
      <div class="form-group" id="sn-group">
        <label for="sn-input">Robot</label>
        <select id="sn-select" style="display:none"><option value="">-- Select robot --</option></select>
        <input type="text" id="sn-input" placeholder="Serial number (or login to pick)" />
        <button id="load-robots-btn" class="btn-scan" style="margin-top:4px;width:100%;font-size:12px;">Load my robots</button>
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
      <button id="connect-btn" class="btn-connect">Connect</button>
      <div id="connection-status" class="status"></div>
    `;

    this.modeSelect = this.container.querySelector('#mode-select')!;
    this.ipInput = this.container.querySelector('#ip-input')!;
    this.snInput = this.container.querySelector('#sn-input')!;
    this.snSelect = this.container.querySelector('#sn-select')!;
    this.loadRobotsBtn = this.container.querySelector('#load-robots-btn')!;
    this.emailInput = this.container.querySelector('#email-input')!;
    this.passwordInput = this.container.querySelector('#password-input')!;
    this.tokenInput = this.container.querySelector('#token-input')!;
    this.connectBtn = this.container.querySelector('#connect-btn')!;
    this.scanBtn = this.container.querySelector('#scan-btn')!;
    this.statusEl = this.container.querySelector('#connection-status')!;
    this.authToggle = this.container.querySelector('#auth-toggle')!;

    // Populate mode selector
    for (const [mode, label] of Object.entries(MODE_LABELS)) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }

    // Auth toggle tabs
    this.authToggle.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.useToken = (tab as HTMLElement).dataset.auth === 'token';
        this.updateVisibility();
      });
    });

    this.modeSelect.addEventListener('change', () => this.updateVisibility());
    this.connectBtn.addEventListener('click', () => this.handleConnect());
    this.scanBtn.addEventListener('click', () => this.handleScan());
    this.loadRobotsBtn.addEventListener('click', () => this.handleLoadRobots());
    this.snSelect.addEventListener('change', () => {
      this.snInput.value = this.snSelect.value;
    });

    this.modeSelect.value = 'STA-L';
    this.ipInput.value = '';
    this.ipInput.placeholder = 'Robot IP on local network';
    this.updateVisibility();
  }

  private updateVisibility(): void {
    const mode = this.modeSelect.value as ConnectionMode;
    const isRemote = mode === 'STA-T';

    const ipGroup = this.container.querySelector('#ip-group') as HTMLElement;
    const snGroup = this.container.querySelector('#sn-group') as HTMLElement;
    const emailGroup = this.container.querySelector('#email-group') as HTMLElement;
    const passwordGroup = this.container.querySelector('#password-group') as HTMLElement;
    const tokenGroup = this.container.querySelector('#token-group') as HTMLElement;

    ipGroup.style.display = isRemote ? 'none' : '';
    snGroup.style.display = isRemote ? '' : 'none';
    this.authToggle.style.display = isRemote ? '' : 'none';

    if (isRemote) {
      // Update tab active state
      this.authToggle.querySelectorAll('.auth-tab').forEach((tab) => {
        const isTokenTab = (tab as HTMLElement).dataset.auth === 'token';
        tab.classList.toggle('active', this.useToken ? isTokenTab : !isTokenTab);
      });

      emailGroup.style.display = this.useToken ? 'none' : '';
      passwordGroup.style.display = this.useToken ? 'none' : '';
      tokenGroup.style.display = this.useToken ? '' : 'none';
    } else {
      emailGroup.style.display = 'none';
      passwordGroup.style.display = 'none';
      tokenGroup.style.display = 'none';
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

  private handleConnect(): void {
    const mode = this.modeSelect.value as ConnectionMode;
    const config: ConnectionConfig = {
      mode,
      ip: this.ipInput.value.trim(),
      token: this.tokenInput.value.trim(),
      serialNumber: this.snInput.value.trim(),
      email: this.emailInput.value.trim(),
      password: this.passwordInput.value.trim(),
    };

    this.onConnect(config);
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
        if (best.sn) this.snInput.value = best.sn;
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

  private async handleLoadRobots(): Promise<void> {
    if (!cloudApi.isLoggedIn) {
      cloudApi.loadSession();
    }
    if (!cloudApi.isLoggedIn) {
      // Try login with current form fields
      const email = this.emailInput.value.trim();
      const pwd = this.passwordInput.value.trim();
      const token = this.tokenInput.value.trim();
      if (token) {
        cloudApi.setAccessToken(token);
      } else if (email && pwd) {
        this.loadRobotsBtn.disabled = true;
        this.loadRobotsBtn.textContent = 'Logging in...';
        try {
          await cloudApi.loginEmail(email, pwd);
        } catch (e) {
          this.setStatus(`Login failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
          this.loadRobotsBtn.disabled = false;
          this.loadRobotsBtn.textContent = 'Load my robots';
          return;
        }
      } else {
        this.setStatus('Enter credentials first or login in Account Manager', 'error');
        return;
      }
    }

    this.loadRobotsBtn.disabled = true;
    this.loadRobotsBtn.textContent = 'Loading...';
    try {
      const devices = await cloudApi.listDevices();
      this.snSelect.innerHTML = '<option value="">-- Select robot --</option>';
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.sn;
        opt.textContent = `${d.alias || d.sn} (${d.series}${d.connIp ? ' / ' + d.connIp : ''})`;
        this.snSelect.appendChild(opt);
      }
      if (devices.length) {
        this.snSelect.style.display = '';
        this.snInput.style.display = 'none';
        this.loadRobotsBtn.style.display = 'none';
        this.setStatus(`Found ${devices.length} robot(s)`, 'success');
        // Auto-select if only one
        if (devices.length === 1) {
          this.snSelect.value = devices[0].sn;
          this.snInput.value = devices[0].sn;
        }
      } else {
        this.setStatus('No robots bound to your account', 'error');
      }
    } catch (e) {
      this.setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.loadRobotsBtn.disabled = false;
      this.loadRobotsBtn.textContent = 'Load my robots';
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

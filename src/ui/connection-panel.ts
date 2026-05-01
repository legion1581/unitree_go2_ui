import type { ConnectionMode, ConnectionConfig } from '../types';
import { MODE_LABELS, DEFAULT_AP_IP } from '../connection/modes';
import { scanForRobots, type ScanResult } from '../connection/network-scan';
import { cloudApi, FAMILY_LABEL, type RobotDevice } from '../api/unitree-cloud';
import { buildCloudPrefsRow } from './components/cloud-prefs';

export type ConnectHandler = (config: ConnectionConfig) => void;

/**
 * Connection panel — Local / AP / Remote chooser.
 * Login lives in the Account Manager; this panel only consumes the cached
 * cloudApi session. Remote mode is disabled when logged out (the option
 * label hints to log in via the Account Manager).
 */
export class ConnectionPanel {
  private container: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private ipInput!: HTMLInputElement;
  private connectBtn!: HTMLButtonElement;
  private scanBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private robotPickerGroup!: HTMLElement;
  private robotSelect!: HTMLSelectElement;
  private remoteHintEl!: HTMLElement;
  private selectedSn = '';
  private devices: RobotDevice[] = [];
  private onConnect: ConnectHandler;
  private onBack: () => void;
  private onAccountManager: () => void;
  private onFamilyChange: (() => void) | null;
  private authUnsub: () => void;

  constructor(
    parent: HTMLElement,
    onConnect: ConnectHandler,
    onBack: () => void,
    onAccountManager: () => void,
    onFamilyChange?: () => void,
  ) {
    this.container = document.createElement('div');
    this.container.className = 'connection-panel';
    this.onConnect = onConnect;
    this.onBack = onBack;
    this.onAccountManager = onAccountManager;
    this.onFamilyChange = onFamilyChange ?? null;
    this.build();
    parent.appendChild(this.container);

    // Re-render on login/logout so the Remote option flips between disabled
    // and "show robot picker".
    this.authUnsub = cloudApi.onAuthChange(() => {
      this.refreshDevicesForRemote();
      this.updateVisibility();
    });
  }

  destroy(): void {
    this.authUnsub();
    this.container.remove();
  }

  private build(): void {
    this.container.innerHTML = `
      <div class="conn-back-row">
        <button id="conn-back-btn" class="conn-back-link" type="button">
          <svg class="conn-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>Main page</span>
        </button>
      </div>
      <h2 class="conn-title">Connect to <span id="conn-family-label"></span></h2>
      <div id="conn-prefs-slot"></div>
      <div class="form-group">
        <label for="mode-select">Connection Mode</label>
        <select id="mode-select"></select>
        <div id="remote-hint" class="conn-remote-hint" style="display:none;"></div>
      </div>
      <div class="form-group" id="ip-group">
        <label for="ip-input">Robot IP Address</label>
        <div class="ip-row">
          <input type="text" id="ip-input" placeholder="192.168.12.1" />
          <button id="scan-btn" class="btn-scan" title="Scan network">Scan</button>
        </div>
        <div id="scan-results" class="scan-results" style="display:none;"></div>
      </div>
      <div class="form-group" id="robot-picker-group" style="display:none">
        <label>Choose Robot</label>
        <select id="robot-select"><option value="">-- Select robot --</option></select>
      </div>
      <button id="connect-btn" class="btn-connect">Connect</button>
      <div id="connection-status" class="status"></div>
    `;

    this.modeSelect = this.container.querySelector('#mode-select')!;
    this.ipInput = this.container.querySelector('#ip-input')!;
    this.connectBtn = this.container.querySelector('#connect-btn')!;
    this.scanBtn = this.container.querySelector('#scan-btn')!;
    this.statusEl = this.container.querySelector('#connection-status')!;
    this.robotPickerGroup = this.container.querySelector('#robot-picker-group')!;
    this.robotSelect = this.container.querySelector('#robot-select')!;
    this.remoteHintEl = this.container.querySelector('#remote-hint')!;
    const backBtn = this.container.querySelector('#conn-back-btn') as HTMLButtonElement;
    backBtn.addEventListener('click', () => this.onBack());

    for (const [mode, label] of Object.entries(MODE_LABELS)) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }

    // Cloud preferences (family + region) — selections drive the AppName
    // header and which Unitree endpoint we hit. Re-render the heading on
    // change so "Connect to <family>" stays in sync.
    const familyLabel = this.container.querySelector('#conn-family-label') as HTMLElement;
    const onPrefChange = (): void => {
      familyLabel.textContent = FAMILY_LABEL[cloudApi.family];
      this.onFamilyChange?.();
    };
    onPrefChange();
    const prefsSlot = this.container.querySelector('#conn-prefs-slot') as HTMLElement;
    // Region lives on the Account Manager login screen — Connect only needs
    // the family switch (Go2 / G1) since it picks the visual label and the
    // local-network scan filter.
    prefsSlot.replaceWith(buildCloudPrefsRow({ showRegion: false, onChange: onPrefChange }));

    this.modeSelect.addEventListener('change', () => {
      // Block selecting Remote while logged out — bounce back to STA-L.
      if (this.modeSelect.value === 'STA-T' && !cloudApi.isLoggedIn) {
        this.modeSelect.value = 'STA-L';
      }
      this.updateVisibility();
    });
    this.connectBtn.addEventListener('click', () => this.handleConnect());

    // Enter key triggers connect
    const handleEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); this.handleConnect(); } };
    this.container.addEventListener('keydown', handleEnter);
    this.scanBtn.addEventListener('click', () => this.handleScan());
    this.robotSelect.addEventListener('change', () => {
      this.selectedSn = this.robotSelect.value;
    });

    this.modeSelect.value = 'STA-L';

    // Restore the last IP the user actually connected with (Local modes
    // only — Remote uses cloud devices). Stored on every successful
    // handleConnect() / handleScan() write.
    try {
      const lastIp = localStorage.getItem('unitree_last_ip');
      if (lastIp) this.ipInput.value = lastIp;
    } catch { /* ignore */ }

    // Pre-populate the robot picker if the user is already logged in
    // (e.g. from auto-login at app start).
    this.refreshDevicesForRemote();
    this.updateVisibility();
  }

  private updateVisibility(): void {
    const mode = this.modeSelect.value as ConnectionMode;
    const isRemote = mode === 'STA-T';
    const ipGroup = this.container.querySelector('#ip-group') as HTMLElement;

    // Remote option label flips based on auth state. The <option> stays
    // selectable so users can see the entry, but the change handler bounces
    // the selection back to STA-L when they're logged out.
    const remoteOpt = Array.from(this.modeSelect.options).find(o => o.value === 'STA-T');
    if (remoteOpt) {
      if (cloudApi.isLoggedIn) {
        remoteOpt.textContent = MODE_LABELS['STA-T'];
        remoteOpt.disabled = false;
      } else {
        remoteOpt.textContent = `${MODE_LABELS['STA-T']} (log in via Account Manager)`;
        remoteOpt.disabled = true;
      }
    }

    ipGroup.style.display = isRemote ? 'none' : '';
    this.robotPickerGroup.style.display = isRemote && cloudApi.isLoggedIn && this.devices.length > 1 ? '' : 'none';

    // Inline hint under the mode selector covers the remaining cases:
    // logged-in single-robot ("ready"), logged-in zero-robots ("bind one"),
    // logged-out ("login required").
    if (isRemote) {
      if (!cloudApi.isLoggedIn) {
        this.remoteHintEl.textContent = 'Login required — open Account Manager';
        this.remoteHintEl.style.display = '';
      } else if (this.devices.length === 0) {
        this.remoteHintEl.innerHTML = 'No robots bound to this account. <a href="#" id="open-acct-link">Open Account Manager</a> to bind one.';
        this.remoteHintEl.style.display = '';
        const link = this.remoteHintEl.querySelector('#open-acct-link') as HTMLAnchorElement | null;
        link?.addEventListener('click', (e) => { e.preventDefault(); this.onAccountManager(); });
      } else if (this.devices.length === 1) {
        const d = this.devices[0];
        this.remoteHintEl.textContent = `Robot: ${d.alias || d.sn}`;
        this.remoteHintEl.style.display = '';
        this.selectedSn = d.sn;
      } else {
        this.remoteHintEl.style.display = 'none';
      }
    } else {
      this.remoteHintEl.style.display = 'none';
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

  /** Fetch the device list when logged in and rebuild the picker.
   *  Called on construct and on login state changes. */
  private refreshDevicesForRemote(): void {
    if (!cloudApi.isLoggedIn) {
      this.devices = [];
      this.populateRobotSelect();
      return;
    }
    void cloudApi.listDevices().then((devices) => {
      this.devices = devices;
      this.populateRobotSelect();
      this.updateVisibility();
    }).catch(() => { /* leave devices as-is on error */ });
  }

  private populateRobotSelect(): void {
    this.robotSelect.innerHTML = '<option value="">-- Select robot --</option>';
    for (const d of this.devices) {
      const opt = document.createElement('option');
      opt.value = d.sn;
      opt.textContent = `${d.alias || d.sn} — ${d.series} [${d.sn}]`;
      this.robotSelect.appendChild(opt);
    }
    if (this.devices.length === 1) {
      this.robotSelect.value = this.devices[0].sn;
      this.selectedSn = this.devices[0].sn;
    }
  }

  private handleConnect(): void {
    const mode = this.modeSelect.value as ConnectionMode;

    if (mode === 'STA-T') {
      if (!cloudApi.isLoggedIn) {
        this.setStatus('Login required — open Account Manager', 'error');
        return;
      }
      const sn = this.selectedSn || this.robotSelect.value || (this.devices.length === 1 ? this.devices[0].sn : '');
      if (!sn) {
        this.setStatus('Please select a robot', 'error');
        return;
      }
      this.onConnect({
        mode,
        ip: '',
        token: cloudApi.accessToken,
        serialNumber: sn,
        email: '',
        password: '',
      });
    } else {
      const ip = this.ipInput.value.trim();
      // Persist the IP for next launch — only for Local modes; AP mode's
      // 192.168.12.1 is hardcoded so storing it is harmless but the
      // STA-L IP is the value that actually changes per network.
      if (ip) try { localStorage.setItem('unitree_last_ip', ip); } catch { /* ignore */ }
      this.onConnect({
        mode,
        ip,
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
    this.renderScanResults([]);  // clear stale list

    try {
      const results = await scanForRobots(cloudApi.family, (msg) => this.setStatus(msg, 'info'));
      if (results.length === 0) {
        this.setStatus('No robots found on network', 'error');
        return;
      }
      // Single hit: just populate the IP, no list needed.
      if (results.length === 1) {
        const only = results[0];
        this.ipInput.value = only.ip;
        if (only.ip !== DEFAULT_AP_IP) {
          this.modeSelect.value = 'STA-L';
          this.updateVisibility();
        }
        this.setStatus(`Found robot at ${only.ip} (SN: ${only.sn || 'unknown'})`, 'success');
        return;
      }
      // Multiple hits: show the list and let the user click one.
      this.modeSelect.value = 'STA-L';
      this.updateVisibility();
      this.setStatus(`Found ${results.length} robots — pick one`, 'success');
      this.renderScanResults(results);
    } catch (err) {
      this.setStatus('Scan failed: ' + (err instanceof Error ? err.message : 'unknown'), 'error');
    } finally {
      this.scanBtn.disabled = false;
      this.scanBtn.textContent = 'Scan';
    }
  }

  /** Render the scan-results dropdown. Empty array hides it. The list
   *  caps at ~4 rows tall and scrolls beyond — taller lists keep the
   *  rest of the connection panel from getting pushed off-screen. */
  private renderScanResults(results: ScanResult[]): void {
    const slot = this.container.querySelector('#scan-results') as HTMLElement;
    if (!slot) return;
    slot.innerHTML = '';
    if (results.length === 0) {
      slot.style.display = 'none';
      return;
    }
    slot.style.display = '';
    for (const r of results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scan-result-row';
      row.innerHTML = `<span class="scan-result-ip">${r.ip}</span><span class="scan-result-sn">${r.sn || 'unknown'}</span>`;
      row.addEventListener('click', () => {
        this.ipInput.value = r.ip;
        this.setStatus(`Selected ${r.ip} (SN: ${r.sn || 'unknown'})`, 'success');
        this.renderScanResults([]);
      });
      slot.appendChild(row);
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

/**
 * Bluetooth page — full-screen view (mirrors AccountPage). Reached from the
 * landing-page Bluetooth tile. Shows the current BLE connection(s) and offers
 * Scan / Connect / Disconnect / WiFi-config controls.
 */

import { btBackend } from '../../api/bt-backend';
import { getCachedAesKey, setCachedAesKey } from '../../api/aes-key-derive';
import { makeCopyButton } from './copy-button';

const BLE_API = '/ble-api';

interface RobotStatus { connected: boolean; address: string; protocol: string; }
interface RemoteStatus { connected: boolean; address: string; name: string; }
interface ScanResult {
  robots: Array<{ name: string; address: string; rssi: number | null; protocol: string }>;
  remotes: Array<{ name: string; address: string; rssi: number | null }>;
}
interface AdapterInfo { name: string; address: string; up: boolean; type: string; }
interface RobotInfo {
  serial_number: string;
  ap_mac: string;
  protocol: string;
  address: string;
}
interface RemoteState {
  lx: number; ly: number; rx: number; ry: number;
  buttons: Record<string, boolean>;
  battery: number;
  rssi: number;
}

// Module-level address → BLE-name cache, populated from scan results.
// Used to gate V3 probes by the actual robot SKU (Go2_* vs G1_*) rather
// than the user's family pill, since the BT page is independent of the
// Connect-screen family selection. Survives popup close/reopen.
const robotNameByAddress: Map<string, string> = new Map();

// Module-level cache for the popup's /info + /v3/* results, keyed by the
// connected BLE address. Survives close/reopen so the panel can paint the
// last-known values immediately and re-fetch in the background, instead of
// always flashing through a "Loading robot info…" → fetch cycle.
type V3Probe = { version: string | null; supported: boolean };
type V3KeyProbe = { key: string | null; supported: boolean };
type CachedRobotPanel = {
  info?: RobotInfo;
  v3Ver?: V3Probe;
  v3Gcm?: V3KeyProbe;
};
const robotPanelCache: Map<string, CachedRobotPanel> = new Map();

export class BtPage {
  private container: HTMLElement;
  private content: HTMLElement;
  private onBack: () => void;
  private robotBody: HTMLElement | null = null;
  private remoteBody: HTMLElement | null = null;
  private emptyPlaceholder: HTMLElement | null = null;
  private adapterBody: HTMLElement | null = null;
  private resultsDiv: HTMLElement | null = null;
  private robotStatus: RobotStatus = { connected: false, address: '', protocol: '' };
  private remoteStatus: RemoteStatus = { connected: false, address: '', name: '' };
  private lastRenderedRemoteAddr = '';   // to avoid DOM rebuild when nothing changed
  private lastRenderedRobotAddr = '';
  // Last-seen V3 + GCM-decode state, used to gate the WiFi form. Reset
  // when status changes to disconnected.
  private v3Supported = false;
  private gcmDecodeWorks = false;
  // Wired by the WiFi form so the AES gate / /info refresh can re-enable
  // it when V3 GCM actually starts decrypting.
  private wifiGateApply: ((enabled: boolean) => void) | null = null;
  // Set by updateRobotSection so the AES gate (and any future caller)
  // can refresh just /info without rebuilding the entire panel — a full
  // rebuild while the user is typing in the AES input ejects focus and
  // turns subsequent backspaces into browser-back navigation.
  private renderInfoRowsCb: ((info: RobotInfo) => void) | null = null;
  private connectingAddrs: Set<string> = new Set();  // addresses with an in-flight connect
  private unsubStatus: (() => void) | null = null;
  private unsubAdapters: (() => void) | null = null;
  private unsubRemoteState: (() => void) | null = null;
  private remoteLiveRefs: {
    leftCanvas: HTMLCanvasElement;
    rightCanvas: HTMLCanvasElement;
    btnEls: Record<string, HTMLElement>;
    stickInfo: HTMLElement;
    meta: HTMLElement;
  } | null = null;

  constructor(parent: HTMLElement, onBack: () => void) {
    this.onBack = onBack;

    this.container = document.createElement('div');
    this.container.className = 'status-page';

    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', () => this.onBack());
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = 'Bluetooth';
    header.appendChild(title);
    this.container.appendChild(header);

    this.content = document.createElement('div');
    this.content.className = 'page-content bt-page-content';
    this.container.appendChild(this.content);
    parent.appendChild(this.container);

    this.buildLayout();

    // Subscribe to backend topics — messages flow in via the shared singleton WS
    this.unsubStatus = btBackend().subscribe('status', (msg: { robot: RobotStatus; remote: RemoteStatus }) => {
      this.robotStatus = msg.robot;
      this.remoteStatus = msg.remote;
      this.updateRobotSection();
      this.updateRemoteSection();
      this.updateScanRowStates();
    });
    this.unsubAdapters = btBackend().subscribe('adapters', (msg: { adapters: AdapterInfo[]; current: string }) => {
      this.updateAdapterSection(msg.adapters, msg.current);
    });
  }

  destroy(): void {
    this.unsubStatus?.(); this.unsubStatus = null;
    this.unsubAdapters?.(); this.unsubAdapters = null;
    this.unsubRemoteState?.(); this.unsubRemoteState = null;
    this.container.remove();
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  private async fetchJSON<T>(path: string, opts?: RequestInit, timeoutMs: number = 15000): Promise<T> {
    const resp = await fetch(`${BLE_API}${path}`, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      const body = await resp.text();
      try { throw new Error(JSON.parse(body).detail || body); }
      catch { throw new Error(body); }
    }
    return resp.json();
  }

  private button(text: string, onClick: () => void, variant: 'primary' | 'danger' | 'secondary' = 'primary'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = `bt-btn bt-btn-${variant}`;
    // No `border:none` inline — let the class control the border (needed for light-theme secondary)
    btn.style.cssText = `padding:6px 12px;font-size:12px;border-radius:5px;cursor:pointer;font-weight:500;`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Compact info row with an optional Copy button. Used for SN / AP MAC so
   * the user can grab those values into the bind form quickly. Renders a
   * dash if `value` is empty (no copy button in that case).
   */
  private infoRowWithCopy(label: string, value: string, dataAttr?: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-height:18px;';
    const lbl = document.createElement('span');
    lbl.style.color = '#666';
    lbl.style.flexShrink = '0';
    lbl.textContent = label;
    const val = document.createElement('span');
    if (dataAttr) val.setAttribute(dataAttr, '');
    val.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;';
    if (value) {
      val.title = value;
      val.textContent = value;
    } else {
      val.style.color = '#555';
      val.textContent = '\u2014';
    }
    row.append(lbl, val);
    if (value) row.appendChild(this.copyButton(value));
    return row;
  }

  private keyRow(label: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;';
    const lbl = document.createElement('span');
    lbl.style.color = '#666';
    lbl.style.flexShrink = '0';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;';
    val.title = value;
    val.textContent = value;
    row.append(lbl, val, this.copyButton(value));
    return row;
  }

  private copyButton(text: string): HTMLButtonElement {
    return makeCopyButton(text);
  }

  private section(title: string): HTMLElement {
    const s = document.createElement('div');
    s.style.cssText = 'margin-bottom:12px;';
    const t = document.createElement('div');
    t.style.cssText = 'font-size:10px;font-weight:700;color:#6879e4;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(104,121,228,0.15);';
    t.textContent = title;
    s.appendChild(t);
    return s;
  }

  private buildLayout(): void {
    this.content.innerHTML = '';

    // Adapter selector
    const adapterSec = this.section('Adapter');
    this.adapterBody = document.createElement('div');
    this.adapterBody.style.minHeight = '28px';
    adapterSec.appendChild(this.adapterBody);
    this.content.appendChild(adapterSec);

    // Connected Devices section (Robot + Remote unified)
    const devicesSec = this.section('Connected Devices');
    this.robotBody = document.createElement('div');
    this.remoteBody = document.createElement('div');
    devicesSec.appendChild(this.robotBody);
    devicesSec.appendChild(this.remoteBody);
    // Placeholder shown if neither is connected
    this.emptyPlaceholder = document.createElement('div');
    this.emptyPlaceholder.style.cssText = 'font-size:12px;color:#666;padding:2px 0;';
    this.emptyPlaceholder.textContent = 'No devices connected';
    devicesSec.appendChild(this.emptyPlaceholder);
    this.content.appendChild(devicesSec);

    // Scan section (results list persists)
    const scanSec = this.section('Scan');
    const scanBtnRow = document.createElement('div');
    scanBtnRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;';
    const scanBtn = this.button('Scan', async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      scanBtn.style.opacity = '0.6';
      this.resultsDiv!.innerHTML = '<div style="color:#888;font-size:12px;padding:6px 2px;">Scanning...</div>';
      try {
        const data = await this.fetchJSON<ScanResult>('/scan?timeout=8');
        this.renderScanResults(data);
      } catch (e) {
        this.resultsDiv!.innerHTML = `<div style="color:#ef5350;font-size:12px;">Scan failed: ${this.esc(e instanceof Error ? e.message : String(e))}</div>`;
      }
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan';
      scanBtn.style.opacity = '1';
    }, 'secondary');
    scanBtnRow.appendChild(scanBtn);
    scanSec.appendChild(scanBtnRow);

    this.resultsDiv = document.createElement('div');
    this.resultsDiv.style.minHeight = '20px';
    scanSec.appendChild(this.resultsDiv);
    this.content.appendChild(scanSec);
  }

  private async refreshStatus(): Promise<void> {
    try {
      const [rs, rem, adapters] = await Promise.all([
        this.fetchJSON<RobotStatus>('/status'),
        this.fetchJSON<RemoteStatus>('/remote/status'),
        this.fetchJSON<{ adapters: AdapterInfo[]; current: string }>('/adapters'),
      ]);
      this.robotStatus = rs;
      this.remoteStatus = rem;
      this.updateRobotSection();  // async but we don't need to await
      this.updateRemoteSection();
      this.updateAdapterSection(adapters.adapters, adapters.current);
      this.updateScanRowStates();
    } catch {
      if (this.robotBody) this.robotBody.innerHTML = '<div style="color:#ef5350;font-size:12px;">BLE server not reachable.</div>';
      if (this.remoteBody) this.remoteBody.innerHTML = '';
      if (this.adapterBody) this.adapterBody.innerHTML = '';
    }
  }

  private updateAdapterSection(adapters: AdapterInfo[], current: string): void {
    if (!this.adapterBody) return;
    this.adapterBody.innerHTML = '';

    // Sort adapters by name so hci0 comes before hci1, etc.
    adapters = [...adapters].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    if (adapters.length === 0) {
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:12px;color:#666;';
      msg.textContent = 'No Bluetooth adapters found';
      this.adapterBody.appendChild(msg);
      return;
    }

    // Vertical list — scrolls internally when there are more than 3 adapters
    // (each row ~30px tall + 4px gap = ~34px; cap at 3 rows = ~104px)
    const list = document.createElement('div');
    const needsScroll = adapters.length > 3;
    list.style.cssText = `display:flex;flex-direction:column;gap:4px;${needsScroll ? 'max-height:104px;overflow-y:auto;padding-right:4px;' : ''}`;
    for (const a of adapters) {
      const isCurrent = a.name === current;
      const row = document.createElement('button');
      row.className = `bt-adapter-row${isCurrent ? ' bt-adapter-row-active' : ''}${!a.up ? ' bt-adapter-row-down' : ''}`;
      row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:5px;font-size:11px;cursor:${isCurrent ? 'default' : 'pointer'};text-align:left;`;
      const dotColor = isCurrent ? '#4fc3f7' : a.up ? '#66bb6a' : '#555';
      row.innerHTML = `
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0;"></span>
        <span style="font-weight:600;min-width:36px;">${this.esc(a.name)}</span>
        <span style="font-family:monospace;font-size:10px;opacity:0.75;flex:1;">${this.esc(a.address)}</span>
        ${a.up ? '' : '<span style="font-size:9px;color:#888;">down</span>'}
        ${isCurrent ? '<span style="font-size:9px;color:#4fc3f7;">active</span>' : ''}
      `;
      if (!isCurrent) {
        row.addEventListener('click', async () => {
          try {
            await this.fetchJSON(`/adapter?name=${encodeURIComponent(a.name)}`, { method: 'POST' });
            await this.refreshStatus();
            if (this.resultsDiv) this.resultsDiv.innerHTML = '';  // clear stale scan
          } catch (e) {
            this.showError(`Switch failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      }
      list.appendChild(row);
    }
    this.adapterBody.appendChild(list);
  }

  private updateEmptyPlaceholder(): void {
    if (!this.emptyPlaceholder) return;
    const anyConnected = this.robotStatus.connected || this.remoteStatus.connected;
    this.emptyPlaceholder.style.display = anyConnected ? 'none' : '';
  }

  private async updateRobotSection(): Promise<void> {
    if (!this.robotBody) return;

    // Skip rebuild if already showing this same robot (prevents WiFi form flicker)
    const currentAddr = this.robotStatus.connected ? this.robotStatus.address : '';
    if (currentAddr === this.lastRenderedRobotAddr && this.robotBody.children.length > 0) {
      return;
    }
    this.lastRenderedRobotAddr = currentAddr;

    this.robotBody.innerHTML = '';
    if (!this.robotStatus.connected) {
      this.robotBody.style.display = 'none';
      // Drop any stale cache for the previously-connected robot so a fresh
      // connection re-fetches /info instead of painting old values.
      robotPanelCache.delete(this.lastRenderedRobotAddr);
      // Reset gate state — a different robot may not even speak V3.
      this.v3Supported = false;
      this.gcmDecodeWorks = false;
      this.wifiGateApply = null;
      this.updateEmptyPlaceholder();
      return;
    }
    this.robotBody.style.display = '';
    this.updateEmptyPlaceholder();

    // Robot header
    const subHeader = document.createElement('div');
    subHeader.style.cssText = 'font-size:10px;font-weight:600;color:#4fc3f7;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;';
    subHeader.textContent = 'Robot';
    this.robotBody.appendChild(subHeader);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:#66bb6a;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const addrText = document.createElement('span');
    addrText.innerHTML = `Connected to <strong style="font-family:monospace;">${this.esc(this.robotStatus.address)}</strong> (${this.esc(this.robotStatus.protocol)})`;
    info.appendChild(addrText);
    if (this.robotStatus.address) info.appendChild(this.copyButton(this.robotStatus.address));
    this.robotBody.appendChild(info);

    // Info rows (serial number, AP MAC) — lazy loaded.
    const infoRows = document.createElement('div');
    infoRows.style.cssText = 'font-size:11px;color:#888;margin-bottom:10px;font-family:monospace;line-height:1.6;';
    this.robotBody.appendChild(infoRows);

    // Use cached values for an instant render, then fall through to fetch.
    const cached = robotPanelCache.get(currentAddr) || {};
    if (!cached.info) {
      infoRows.innerHTML = '<div>Loading robot info...</div>';
    }

    // /info gives us the V1/V2 transport label; /v3/* tells us whether the
    // V3 GCM-key extension is also present. Surface the protocol row as
    // "V2 (NUS) + V3" when both are detected. Both fetches run in parallel;
    // a small render() reads the latest known state and rewrites the row.
    let baseProto: string | undefined;
    let v3Supported: boolean | undefined;
    const renderProtoRow = (): void => {
      const cell = infoRows.querySelector('[data-proto-row]');
      if (!cell || baseProto === undefined) return;
      const suffix = v3Supported === true ? ' + V3' : '';
      cell.innerHTML = `<span style="color:#666;">Protocol:</span> ${this.esc(baseProto + suffix)}`;
    };

    const renderInfoRows = (rInfo: RobotInfo): void => {
      // Map the backend's protocol token to a human-readable version label.
      // V1 = legacy FFE0 service (Go2 < 1.1.11, all G1). V2 = Nordic UART
      // (Go2 >= 1.1.11). See docs/bluetooth-v1-v2.md.
      baseProto = rInfo.protocol === 'nus'  ? 'V2 (NUS)'
                : rInfo.protocol === 'ffe0' ? 'V1 (FFE0)'
                : (rInfo.protocol || '—');
      const snVal = rInfo.serial_number || '';
      const macVal = rInfo.ap_mac || '';
      infoRows.innerHTML = '';
      infoRows.appendChild(this.infoRowWithCopy('SN:', snVal, 'data-sn'));
      infoRows.appendChild(this.infoRowWithCopy('AP MAC:', macVal, 'data-mac'));
      // On V3 firmware, /info returning a real AP MAC proves the AES key
      // is decrypting frames correctly (the F1 fallback path populates SN
      // only, never AP MAC). That's our signal to ungate the WiFi form.
      this.gcmDecodeWorks = !!macVal;
      this.refreshWifiGate();
      const proto = document.createElement('div');
      proto.setAttribute('data-proto-row', '');
      proto.innerHTML = `<span style="color:#666;">Protocol:</span> ${this.esc(baseProto)}`;
      infoRows.appendChild(proto);
      renderProtoRow();
    };

    this.renderInfoRowsCb = renderInfoRows;
    if (cached.info) renderInfoRows(cached.info);
    this.fetchJSON<RobotInfo>('/info').then((rInfo) => {
      robotPanelCache.set(currentAddr, { ...(robotPanelCache.get(currentAddr) || {}), info: rInfo });
      renderInfoRows(rInfo);
    }).catch(() => {
      if (!cached.info) infoRows.innerHTML = '<div style="color:#888;">Info unavailable</div>';
    });

    // V3 info (G1 firmware 1.5.1+ only — see docs/bluetooth-v3.md). Per
    // the support table, V3 was never shipped on Go2 (any firmware), so
    // we only build the V3 panel when the connected device's BLE name
    // confirms it's a G1. Keying off the actual scanned name (rather
    // than the user's Connect-screen family pill) is correct here:
    // BT scan can surface Go2_* and G1_* at the same time, so a single
    // family pill can't represent the active BT pairing.
    //
    // When the name isn't known (e.g. reconnect across popup close
    // without rescanning), default to *no probe* so Go2 reconnects stay
    // quiet — G1 users can hit Scan once to repopulate the cache.
    const robotName = robotNameByAddress.get(currentAddr) || '';
    const probeV3 = /^G1[_\W]/i.test(robotName);
    const v3Rows = document.createElement('div');
    v3Rows.style.cssText = 'font-size:11px;color:#888;margin-bottom:10px;font-family:monospace;line-height:1.6;';
    if (probeV3 && !cached.v3Ver && !cached.v3Gcm) {
      v3Rows.innerHTML = '<div style="color:#666;">V3 (loading…)</div>';
    }
    if (probeV3) this.robotBody.appendChild(v3Rows);

    // AES-128 paste field — only useful on V3 firmware (G1 ≥ 1.5.1).
    // Build *only* when we're actually probing V3: buildAesGate's
    // constructor pre-fills from the localStorage AES cache and, if
    // anything's there, immediately POSTs /v3/aes-key. That side-effect
    // would generate spurious BLE traffic on Go2 even with the panel
    // hidden — so skip the construction entirely when probeV3 is false.
    let aesGate: ReturnType<BtPage['buildAesGate']> | null = null;
    if (probeV3) {
      aesGate = this.buildAesGate();
      aesGate.wrap.style.display = 'none';
      this.robotBody.appendChild(aesGate.wrap);
    }

    const renderV3 = (gcm: V3KeyProbe, ver: V3Probe): void => {
      v3Supported = gcm.supported || ver.supported;
      this.v3Supported = v3Supported;
      this.refreshWifiGate();
      renderProtoRow();
      if (!v3Supported) {
        v3Rows.remove();
        aesGate?.wrap.remove();
        return;
      }
      v3Rows.innerHTML = '';
      if (ver.supported && ver.version) {
        const row = document.createElement('div');
        row.innerHTML = `<span style="color:#666;">FW Ver:</span> ${this.esc(ver.version)}`;
        v3Rows.appendChild(row);
      }
      if (gcm.supported && gcm.key) {
        // What F2 actually returns is a 256-byte RSA-encrypted blob (344
        // chars b64), not a plain key. Under MTU<32 the F2 chunks get
        // truncated to ~44 chars total — flag that so the user knows the
        // payload is unusable for bindExtData.
        const isFull = gcm.key.length >= 300;
        v3Rows.appendChild(this.keyRow(
          isFull ? '344B RSA:' : `344B RSA (TRUNCATED ${gcm.key.length} ch — MTU exchange failed):`,
          gcm.key,
        ));
      }
      if (aesGate) aesGate.wrap.style.display = '';
    };

    if (probeV3) {
      if (cached.v3Ver && cached.v3Gcm) renderV3(cached.v3Gcm, cached.v3Ver);
      Promise.all([
        this.fetchJSON<V3KeyProbe>('/v3/gcm-key', undefined, 6000).catch(() => ({ key: null, supported: false }) as V3KeyProbe),
        this.fetchJSON<V3Probe>('/v3/version', undefined, 6000).catch(() => ({ version: null, supported: false }) as V3Probe),
      ]).then(([gcm, ver]) => {
        robotPanelCache.set(currentAddr, { ...(robotPanelCache.get(currentAddr) || {}), v3Gcm: gcm, v3Ver: ver });
        renderV3(gcm, ver);
      });
    } else {
      // Go2: short-circuit the gate state — V3 not supported, so the
      // WiFi form ungate path treats this as a regular V1/V2 connection.
      renderV3({ key: null, supported: false }, { version: null, supported: false });
    }

    // WiFi config — gated on V3 firmware until a valid AES-128 key is provided.
    // The aesGate field above publishes its state via `aesGate.isReady()`; we
    // wire the form to listen so it disables/enables in real time.
    const wifiHeader = document.createElement('div');
    wifiHeader.style.cssText = 'font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:1px;margin:8px 0 6px;';
    wifiHeader.textContent = 'WiFi Configuration';
    this.robotBody.appendChild(wifiHeader);

    // Mode toggle
    let apMode = false;
    const modeWrap = document.createElement('div');
    modeWrap.className = 'bt-mode-wrap';
    modeWrap.style.cssText = 'display:flex;gap:0;margin-bottom:8px;border-radius:6px;overflow:hidden;';
    const staBtn = document.createElement('button');
    const apBtn = document.createElement('button');
    const applyMode = (btn: HTMLButtonElement, active: boolean) => {
      btn.className = `bt-mode-btn${active ? ' bt-mode-btn-active' : ''}`;
      btn.style.cssText = 'flex:1;padding:6px 4px;border:none;cursor:pointer;font-size:11px;font-weight:600;';
    };
    applyMode(staBtn, true); staBtn.textContent = 'STA';
    applyMode(apBtn, false); apBtn.textContent = 'AP';
    staBtn.addEventListener('click', () => { apMode = false; applyMode(staBtn, true); applyMode(apBtn, false); });
    apBtn.addEventListener('click', () => { apMode = true; applyMode(apBtn, true); applyMode(staBtn, false); });
    modeWrap.appendChild(staBtn);
    modeWrap.appendChild(apBtn);
    this.robotBody.appendChild(modeWrap);

    const ssidInput = this.wifiInput('SSID', 'text');
    const pwdInput = this.wifiInput('Password', 'password');
    // This password belongs to the robot's WiFi, not to the user — don't let the
    // browser autofill it with saved account credentials and don't save it.
    pwdInput.input.autocomplete = 'off';
    pwdInput.input.setAttribute('data-lpignore', 'true');  // LastPass hint
    const countrySelect = this.wifiCountrySelect();
    // Wrap in a <form> so Chrome doesn't warn about a standalone password field.
    const wifiForm = document.createElement('form');
    wifiForm.autocomplete = 'off';
    wifiForm.addEventListener('submit', (e) => e.preventDefault());
    wifiForm.appendChild(ssidInput.wrap);
    wifiForm.appendChild(pwdInput.wrap);
    wifiForm.appendChild(countrySelect.wrap);
    this.robotBody.appendChild(wifiForm);

    const wifiStatus = document.createElement('div');
    wifiStatus.style.cssText = 'font-size:11px;min-height:14px;margin-top:4px;';

    const applyRow = document.createElement('div');
    applyRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const applyBtn = this.button('Apply WiFi', async () => {
      const ssid = ssidInput.input.value.trim();
      if (!ssid) { wifiStatus.textContent = 'SSID required'; wifiStatus.style.color = '#ef5350'; return; }
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying...';
      wifiStatus.textContent = 'Sending...';
      wifiStatus.style.color = '#4fc3f7';
      // Send phase covers the four GCM-acked ops (TYPE/SSID/PWD/COUNTRY)
      // — typically <4 s. After that the backend waits up to 40 s for the
      // robot's op-0x08 ready push, so flip the label so the user knows
      // we're now waiting on the robot, not the link.
      const awaitTimer = window.setTimeout(() => {
        wifiStatus.textContent = 'Awaiting connection...';
      }, 4000);
      try {
        const resp = await this.fetchJSON<{ success: boolean; details: Record<string, boolean>; error: string | null }>('/wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password: pwdInput.input.value, ap_mode: apMode, country: countrySelect.select.value }),
        }, 60000);
        if (resp.success) {
          wifiStatus.textContent = 'WiFi configured';
          wifiStatus.style.color = '#66bb6a';
        } else if (resp.error) {
          // The backend already mapped the failed step + result code to a
          // human message — prefer it over the raw key list.
          wifiStatus.textContent = resp.error;
          wifiStatus.style.color = '#ff9800';
        } else {
          // Pre-ready failure (TYPE/SSID/PWD/COUNTRY rejected by the
          // firmware). Map the failed key to a human label.
          const stepLabels: Record<string, string> = {
            mode: 'set mode',
            ssid: 'set SSID',
            password: 'set password',
            country: 'apply country / start AP',
          };
          const failed = Object.entries(resp.details)
            .filter(([, v]) => v === false)
            .map(([k]) => stepLabels[k] || k)
            .join(', ');
          wifiStatus.textContent = failed ? `Failed at: ${failed}` : 'Failed';
          wifiStatus.style.color = '#ff9800';
        }
      } catch (e) {
        wifiStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
        wifiStatus.style.color = '#ef5350';
      } finally {
        clearTimeout(awaitTimer);
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply WiFi';
      }
    });
    applyBtn.style.cssText += 'flex:1;padding:6px 10px;';

    const disc = this.button('Disconnect', async () => {
      disc.disabled = true;
      try { await this.fetchJSON('/disconnect', { method: 'POST' }); } catch {}
      this.refreshStatus();
    }, 'danger');
    disc.style.cssText += 'padding:6px 10px;';

    applyRow.appendChild(applyBtn);
    applyRow.appendChild(disc);
    this.robotBody.appendChild(applyRow);
    this.robotBody.appendChild(wifiStatus);

    // WiFi gate: V1/V2 firmware is always enabled; V3 firmware stays
    // greyed out until BOTH a 32-hex AES-128 key is in the input AND
    // /info has confirmed the key actually GCM-decrypts (real AP MAC
    // back from the robot, not just the F1-extracted SN). Disconnect
    // button stays clickable in either case.
    const setWifiEnabled = (enabled: boolean): void => {
      const dim = enabled ? '' : '0.4';
      [ssidInput.input, pwdInput.input, countrySelect.select, applyBtn].forEach((el) => {
        (el as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = !enabled;
      });
      [ssidInput.wrap, pwdInput.wrap, countrySelect.wrap, applyBtn].forEach((el) => {
        (el as HTMLElement).style.opacity = dim;
      });
      [staBtn, apBtn].forEach((b) => { b.disabled = !enabled; b.style.opacity = dim; });
    };
    this.wifiGateApply = setWifiEnabled;
    if (aesGate) {
      aesGate.onChange(() => this.refreshWifiGate());
      // Initial gate evaluation — pulls v3Supported / gcmDecodeWorks from
      // whatever the V3 + /info promises have set so far.
      this.aesGateReady = aesGate.isReady;
    } else {
      // No V3 path on this device — keep aesGateReady at its safe default
      // (() => false). v3Supported stays false too, so the WiFi gate
      // shortcuts to "always enabled".
      this.aesGateReady = () => false;
    }
    this.refreshWifiGate();
  }

  /** Re-evaluate the WiFi form's enabled state from the current
   *  (v3Supported, gcmDecodeWorks, aesGateReady) tuple. Cheap, idempotent.
   *  V1/V2 firmware: always enabled.
   *  V3 firmware: enabled iff AES key is 32 hex chars AND /info has
   *  returned a real AP MAC (proof the key decrypts). */
  private aesGateReady: () => boolean = () => false;
  private refreshWifiGate(): void {
    if (!this.wifiGateApply) return;
    const enabled = !this.v3Supported || (this.aesGateReady() && this.gcmDecodeWorks);
    this.wifiGateApply(enabled);
  }

  /** Refresh /info and re-render the SN / AP MAC rows in place. Used
   *  after the AES key gate POSTs a new key to the backend — the user
   *  is mid-typing in the AES input, so we must NOT rebuild the whole
   *  panel (that ejects focus and turns subsequent backspaces into
   *  browser-back navigation). Updates only the existing infoRows DOM. */
  private async refreshInfo(): Promise<void> {
    if (!this.robotStatus.connected) return;
    const addr = this.robotStatus.address;
    try {
      const rInfo = await this.fetchJSON<RobotInfo>('/info');
      robotPanelCache.set(addr, { ...(robotPanelCache.get(addr) || {}), info: rInfo });
      this.renderInfoRowsCb?.(rInfo);
    } catch { /* leave previous values in place */ }
  }

  /**
   * Build the AES-128 key input. On V3 firmware (G1 ≥ 1.5.1) the per-device
   * 16-byte key gates SN / AP MAC fetches and the WiFi form, since all
   * those ops are AES-GCM-encrypted. The key is keyed by SN — but we don't
   * know the SN before the key decrypts the first GET_SN, so we just
   * surface the last-used key (or any single cached entry from the Account
   * page) and let the user paste/edit.
   */
  private buildAesGate(): { wrap: HTMLElement; isReady: () => boolean; onChange: (cb: (ready: boolean) => void) => void } {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:10px;padding:8px 10px;border:1px solid #2a2d35;border-radius:6px;background:rgba(0,0,0,0.15);';

    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:11px;color:#666;margin-bottom:6px;';
    lbl.textContent = 'AES-128 Key (required to unlock WiFi / SN / AP MAC)';
    wrap.appendChild(lbl);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '32 hex characters';
    input.className = 'bt-field';
    input.style.cssText = 'flex:1;padding:6px 8px;font-family:monospace;font-size:11px;border-radius:4px;box-sizing:border-box;';
    row.appendChild(input);

    const status = document.createElement('span');
    status.style.cssText = 'font-size:11px;min-width:54px;text-align:right;';
    row.appendChild(status);

    wrap.appendChild(row);

    // Try to surface any AES key the user has already cached via the Account
    // page (any device — the popup doesn't yet know which SN this BLE robot
    // maps to, but offering the most recently cached key is a reasonable
    // first guess). Stored under unitree_aes_keys_v1 → {sn: hex}.
    let candidate = '';
    try {
      const raw = localStorage.getItem('unitree_aes_keys_v1');
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
        const entries = Object.entries(obj).filter(([, v]) => /^[0-9a-fA-F]{32}$/.test(v));
        if (entries.length === 1) candidate = entries[0][1];
      }
    } catch { /* corrupt cache */ }
    if (candidate) input.value = candidate;

    const listeners: Array<(ready: boolean) => void> = [];
    let lastReady = false;
    // We always POST the key on transition-to-ready (initial pre-fill or
    // user edit) AND always refresh /info afterwards. The earlier guard
    // that skipped refreshInfo on initial pre-fill was wrong — without
    // refresh, /info had already returned before the AES key was set, so
    // SN/MAC stayed empty and the WiFi gate stayed disabled.
    const refresh = (): void => {
      const v = input.value.trim();
      const ready = /^[0-9a-fA-F]{32}$/.test(v);
      if (ready) {
        status.textContent = '✓ ready';
        status.style.color = '#66bb6a';
      } else if (v.length === 0) {
        status.textContent = 'paste key';
        status.style.color = '#888';
      } else {
        status.textContent = `${v.length}/32`;
        status.style.color = '#ff9800';
      }
      if (ready !== lastReady) {
        lastReady = ready;
        if (ready) {
          try { setCachedAesKey('_last', v.toLowerCase()); } catch { /* private mode */ }
          (async () => {
            try {
              // Backend now runs the full GCM handshake (GET_TIME_3 →
              // CHECK_3 ack) before returning, which can take up to ~10 s
              // when this call races ahead of /connect. Give it room.
              const resp = await fetch(`${BLE_API}/v3/aes-key?key=${encodeURIComponent(v.toLowerCase())}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
              if (!resp.ok) {
                const body = await resp.text();
                status.textContent = `key rejected: ${body.slice(0, 60)}`;
                status.style.color = '#e57373';
                return;
              }
              const body = await resp.json().catch(() => ({} as { armed?: boolean }));
              if (body.armed) {
                status.textContent = '✓ key armed';
                status.style.color = '#66bb6a';
                // Handshake confirmed — /info will now resolve SN/MAC on
                // the first try. refreshInfo() updates the SN/MAC rows
                // in place so it doesn't eject focus from this input.
                this.refreshInfo();
              } else {
                // Backend installed the key but the handshake didn't
                // complete (likely raced ahead of /connect, or robot
                // didn't reply). One automatic retry: poll /info a few
                // times — the connect flow may finish armed soon after.
                status.textContent = '… arming key';
                status.style.color = '#ff9800';
                for (let attempt = 0; attempt < 4; attempt++) {
                  await new Promise(r => setTimeout(r, 1500));
                  try {
                    const info = await this.fetchJSON<RobotInfo>('/info');
                    if (info.ap_mac) {
                      // /info returning AP MAC proves the GCM path is
                      // working now (F1 fallback never populates MAC).
                      status.textContent = '✓ key armed';
                      status.style.color = '#66bb6a';
                      this.renderInfoRowsCb?.(info);
                      return;
                    }
                  } catch { /* keep retrying */ }
                }
                status.textContent = 'key not armed — try reconnect';
                status.style.color = '#e57373';
              }
            } catch (e) {
              status.textContent = `send failed: ${e instanceof Error ? e.message : String(e)}`;
              status.style.color = '#e57373';
            }
          })();
        }
        for (const cb of listeners) cb(ready);
      }
    };
    input.addEventListener('input', refresh);
    // Defense in depth: when the input briefly loses focus (e.g. status
    // update repaints something nearby) some browsers route Backspace to
    // history.back(). Stop the key from bubbling out of the input — the
    // input still gets the default delete behavior.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation();
    });
    // Use the "_last" sentinel as a fallback if no candidate was set.
    if (!candidate) {
      const last = getCachedAesKey('_last');
      if (last) input.value = last;
    }
    refresh();

    return {
      wrap,
      isReady: () => lastReady,
      onChange: (cb) => { listeners.push(cb); },
    };
  }

  private wifiInput(label: string, type: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:6px;';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:10px;color:#666;margin-bottom:2px;';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    const input = document.createElement('input');
    input.type = type;
    input.className = 'bt-field';
    input.style.cssText = 'width:100%;padding:6px 8px;border-radius:4px;font-size:12px;box-sizing:border-box;';
    wrap.appendChild(input);
    return { wrap, input };
  }

  private wifiCountrySelect(): { wrap: HTMLElement; select: HTMLSelectElement } {
    // Common WiFi regulatory codes (ISO 3166-1 alpha-2). Linux wireless-regdb accepts 200+;
    // this is a curated subset covering North America, Europe, APAC, and major markets.
    // The firmware delegates validation to the kernel regulatory database — any code
    // supported by `iw reg set` will work; unknown codes are silently ignored.
    const countries: Array<[string, string]> = [
      ['US', 'United States'],
      ['CA', 'Canada'],
      ['MX', 'Mexico'],
      ['GB', 'United Kingdom'],
      ['DE', 'Germany'],
      ['FR', 'France'],
      ['IT', 'Italy'],
      ['ES', 'Spain'],
      ['NL', 'Netherlands'],
      ['BE', 'Belgium'],
      ['PL', 'Poland'],
      ['SE', 'Sweden'],
      ['NO', 'Norway'],
      ['FI', 'Finland'],
      ['DK', 'Denmark'],
      ['CH', 'Switzerland'],
      ['AT', 'Austria'],
      ['IE', 'Ireland'],
      ['PT', 'Portugal'],
      ['CZ', 'Czech Republic'],
      ['GR', 'Greece'],
      ['RO', 'Romania'],
      ['JP', 'Japan'],
      ['KR', 'South Korea'],
      ['CN', 'China'],
      ['TW', 'Taiwan'],
      ['HK', 'Hong Kong'],
      ['SG', 'Singapore'],
      ['IN', 'India'],
      ['AU', 'Australia'],
      ['NZ', 'New Zealand'],
      ['BR', 'Brazil'],
      ['AR', 'Argentina'],
      ['ZA', 'South Africa'],
      ['IL', 'Israel'],
      ['AE', 'United Arab Emirates'],
      ['SA', 'Saudi Arabia'],
      ['TR', 'Turkey'],
      ['RU', 'Russia'],
      ['UA', 'Ukraine'],
    ];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:6px;';
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:block;font-size:10px;color:#666;margin-bottom:2px;';
    lbl.textContent = 'Region';
    wrap.appendChild(lbl);
    const select = document.createElement('select');
    select.className = 'bt-field';
    select.style.cssText = 'width:100%;padding:6px 8px;border-radius:4px;font-size:12px;box-sizing:border-box;cursor:pointer;';
    for (const [code, name] of countries) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${code} — ${name}`;
      if (code === 'US') opt.selected = true;
      select.appendChild(opt);
    }
    wrap.appendChild(select);
    return { wrap, select };
  }

  private updateRemoteSection(): void {
    if (!this.remoteBody) return;

    // If the same remote is still connected and we've already rendered it,
    // skip DOM rebuild (the live state keeps updating via WebSocket/poll in-place).
    const currentAddr = this.remoteStatus.connected ? this.remoteStatus.address : '';
    if (currentAddr === this.lastRenderedRemoteAddr && this.remoteLiveRefs) {
      return;
    }
    this.lastRenderedRemoteAddr = currentAddr;

    // State changed — tear down any existing live view
    this.stopRemoteStream();
    this.remoteLiveRefs = null;
    this.remoteBody.innerHTML = '';

    if (!this.remoteStatus.connected) {
      this.remoteBody.style.display = 'none';
      this.updateEmptyPlaceholder();
      return;
    }
    this.remoteBody.style.display = '';
    this.updateEmptyPlaceholder();

    // Separator if robot section above is also showing
    if (this.robotStatus.connected) {
      const sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px dashed #1f2229;margin:10px 0;';
      this.remoteBody.appendChild(sep);
    }

    // Remote header
    const subHeader = document.createElement('div');
    subHeader.style.cssText = 'font-size:10px;font-weight:600;color:#4fc3f7;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;';
    subHeader.textContent = 'Remote';
    this.remoteBody.appendChild(subHeader);

    const label = this.remoteStatus.name || this.remoteStatus.address;
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:4px;';
    header.innerHTML = `<div style="font-size:12px;color:#66bb6a;">Connected: <strong>${this.esc(label)}</strong></div>`;
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#666;font-family:monospace;';
    header.appendChild(meta);
    this.remoteBody.appendChild(header);

    // Controller body
    const ctrl = document.createElement('div');
    ctrl.style.cssText = 'background:#0a0c10;border-radius:8px;border:1px solid #1f2229;padding:10px;margin-bottom:8px;';
    this.remoteBody.appendChild(ctrl);

    const btnEls: Record<string, HTMLElement> = {};
    const mkBtn = (name: string, w = '28px') => {
      const el = document.createElement('div');
      el.style.cssText = `padding:3px 6px;border-radius:4px;font-size:9px;font-family:monospace;text-align:center;min-width:${w};border:1px solid #1f2229;background:#111318;color:#555;user-select:none;`;
      el.textContent = name;
      btnEls[name] = el;
      return el;
    };

    // Shoulders
    const shoulders = document.createElement('div');
    shoulders.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:8px;';
    const shL = document.createElement('div'); shL.style.cssText = 'display:flex;gap:4px;';
    const shR = document.createElement('div'); shR.style.cssText = 'display:flex;gap:4px;';
    shL.append(mkBtn('L2'), mkBtn('L1'));
    shR.append(mkBtn('R1'), mkBtn('R2'));
    shoulders.append(shL, shR);
    ctrl.appendChild(shoulders);

    // Sticks
    const stickRow = document.createElement('div');
    stickRow.style.cssText = 'display:flex;justify-content:space-around;align-items:center;margin:6px 0;';
    const mkStick = () => {
      const c = document.createElement('canvas');
      c.width = 72; c.height = 72;
      c.style.cssText = 'border-radius:50%;background:#080a0e;border:1px solid #1a1d23;';
      return c;
    };
    const leftCanvas = mkStick();
    const rightCanvas = mkStick();
    stickRow.append(leftCanvas, rightCanvas);
    ctrl.appendChild(stickRow);

    // D-pad + ABXY
    const faceRow = document.createElement('div');
    faceRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:8px 0;';
    const empty = () => document.createElement('div');
    const dpad = document.createElement('div');
    dpad.style.cssText = 'display:grid;grid-template-columns:24px 24px 24px;grid-template-rows:22px 22px 22px;gap:2px;justify-items:center;align-items:center;';
    dpad.append(empty(), mkBtn('Up', '24px'), empty(), mkBtn('Left', '24px'), empty(), mkBtn('Right', '24px'), empty(), mkBtn('Down', '24px'), empty());
    const abxy = document.createElement('div');
    abxy.style.cssText = 'display:grid;grid-template-columns:26px 26px 26px;grid-template-rows:22px 22px 22px;gap:2px;justify-items:center;align-items:center;';
    abxy.append(empty(), mkBtn('Y', '26px'), empty(), mkBtn('X', '26px'), empty(), mkBtn('B', '26px'), empty(), mkBtn('A', '26px'), empty());
    faceRow.append(dpad, abxy);
    ctrl.appendChild(faceRow);

    // F1/Select F2/Start
    const bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display:flex;justify-content:space-between;margin-top:8px;';
    const bL = document.createElement('div'); bL.style.cssText = 'display:flex;gap:4px;';
    const bR = document.createElement('div'); bR.style.cssText = 'display:flex;gap:4px;';
    bL.append(mkBtn('F1', '44px'), mkBtn('Select', '44px'));
    bR.append(mkBtn('F2', '44px'), mkBtn('Start', '44px'));
    bottomRow.append(bL, bR);
    ctrl.appendChild(bottomRow);

    // Stick info text
    const stickInfo = document.createElement('div');
    stickInfo.style.cssText = 'text-align:center;font-size:9px;color:#555;font-family:monospace;margin-top:6px;';
    ctrl.appendChild(stickInfo);

    // Heads-up: tearing down the BLE link kills the BT-remote relay too.
    // Users coming here just to *check* the relay status should hit the
    // page back button instead of Disconnect — see README → "BT remote
    // relay" for the full flow.
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;padding:8px 10px;border-left:2px solid #4fc3f7;background:rgba(79,195,247,0.06);border-radius:4px;font-size:11px;color:#aaa;line-height:1.5;';
    note.innerHTML = 'Want to use the <strong style="color:#4fc3f7;">BT remote relay</strong> on the control screen? Press the page <strong>back button</strong> — Disconnect tears down the BLE link and the relay loses its source. (See README → "BT remote relay".)';
    this.remoteBody.appendChild(note);

    // Disconnect
    const disc = this.button('Disconnect Remote', async () => {
      disc.disabled = true;
      this.stopRemoteStream();
      try { await this.fetchJSON('/remote/disconnect', { method: 'POST' }); } catch {}
      this.refreshStatus();
    }, 'danger');
    disc.style.marginTop = '8px';
    this.remoteBody.appendChild(disc);

    // Store refs + subscribe to WebSocket for push updates
    this.remoteLiveRefs = { leftCanvas, rightCanvas, btnEls, stickInfo, meta };
    this.startRemoteStream();
  }

  private stopRemoteStream(): void {
    this.unsubRemoteState?.();
    this.unsubRemoteState = null;
  }

  private signalBars(rssi: number): string {
    // APK thresholds (RemoteActivity): 0 -> none, >=-70 5, >=-75 4, >=-83 3, >=-90 2, >=-100 2, < -100 1
    let level: number;
    if (rssi === 0) level = 0;
    else if (rssi >= -70) level = 5;
    else if (rssi >= -75) level = 4;
    else if (rssi >= -83) level = 3;
    else if (rssi >= -90) level = 2;
    else level = 1;

    // 5 bars, increasing heights: 3, 5, 7, 9, 11 (px)
    const heights = [3, 5, 7, 9, 11];
    const active = '#4fc3f7';
    const inactive = '#333';

    let bars = '';
    for (let i = 0; i < 5; i++) {
      const h = heights[i];
      const y = 12 - h; // baseline alignment
      const fill = i < level ? active : inactive;
      const x = 1 + i * 3; // 2px wide + 1px gap
      bars += `<rect x="${x}" y="${y}" width="2" height="${h}" fill="${fill}" rx="0.5"/>`;
    }
    return `<span title="RSSI: ${rssi} dBm" style="display:inline-flex;align-items:center;vertical-align:middle;"><svg width="16" height="13" viewBox="0 0 16 13" style="display:block;">${bars}</svg></span>`;
  }

  private drawStick(canvas: HTMLCanvasElement, x: number, y: number): void {
    const ctx = canvas.getContext('2d')!;
    const s = canvas.width, cx = s / 2, cy = s / 2, r = s * 0.37;
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = '#1a1d23';
    ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, s - 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, cy); ctx.lineTo(s - 4, cy); ctx.stroke();
    ctx.strokeStyle = '#2a2d35';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#4fc3f7';
    ctx.beginPath(); ctx.arc(cx + x * r, cy - y * r, 5, 0, Math.PI * 2); ctx.fill();
  }

  private startRemoteStream(): void {
    if (!this.remoteLiveRefs) return;
    let frames = 0;
    let lastTime = performance.now();
    let hz = 0;

    const render = (s: RemoteState) => {
      if (!this.remoteLiveRefs) return;
      frames++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        hz = Math.round(frames * 1000 / (now - lastTime));
        frames = 0; lastTime = now;
      }
      const { leftCanvas, rightCanvas, btnEls, stickInfo, meta } = this.remoteLiveRefs;
      this.drawStick(leftCanvas, s.lx, s.ly);
      this.drawStick(rightCanvas, s.rx, s.ry);
      for (const [n, pressed] of Object.entries(s.buttons)) {
        const el = btnEls[n];
        if (!el) continue;
        el.style.borderColor = pressed ? '#4fc3f7' : '#1f2229';
        el.style.background = pressed ? 'rgba(79,195,247,0.15)' : '#111318';
        el.style.color = pressed ? '#4fc3f7' : '#555';
      }
      stickInfo.textContent = `LX:${s.lx.toFixed(2)} LY:${s.ly.toFixed(2)} RX:${s.rx.toFixed(2)} RY:${s.ry.toFixed(2)}`;
      meta.innerHTML = `${hz} Hz · ${s.battery}% · ${this.signalBars(s.rssi)}`;
    };

    this.unsubRemoteState = btBackend().subscribe('remote_state', (msg: RemoteState) => render(msg));
  }

  private updateScanRowStates(): void {
    // Flip any Connect buttons to green Connected tag when state changes.
    // Skip rows whose connect is currently in flight — we don't want to wipe the spinner.
    if (!this.resultsDiv) return;
    for (const row of Array.from(this.resultsDiv.querySelectorAll('[data-device-addr]')) as HTMLElement[]) {
      const addr = row.getAttribute('data-device-addr')!;
      if (this.connectingAddrs.has(addr)) continue;  // preserve spinner
      const type = row.getAttribute('data-device-type')!;
      const isConnected = (type === 'Robot' && this.robotStatus.address === addr && this.robotStatus.connected)
        || (type === 'Remote' && this.remoteStatus.address === addr && this.remoteStatus.connected);
      const actionCell = row.querySelector('[data-device-action]') as HTMLElement | null;
      if (!actionCell) continue;
      actionCell.innerHTML = '';
      if (isConnected) {
        const tag = document.createElement('span');
        tag.style.cssText = 'font-size:10px;color:#66bb6a;padding:4px 8px;background:rgba(102,187,106,0.1);border-radius:4px;flex-shrink:0;';
        tag.textContent = 'Connected';
        actionCell.appendChild(tag);
      } else {
        const btn = this.button('Connect', () => this.handleConnect(row, type, addr, btn));
        btn.style.cssText += 'padding:4px 0;font-size:11px;width:80px;flex-shrink:0;display:flex;align-items:center;justify-content:center;min-height:26px;';
        actionCell.appendChild(btn);
      }
    }
  }

  private renderScanResults(data: ScanResult): void {
    if (!this.resultsDiv) return;
    this.resultsDiv.innerHTML = '';
    const total = data.robots.length + data.remotes.length;
    if (total === 0) {
      this.resultsDiv.innerHTML = '<div style="color:#666;font-size:12px;padding:6px 2px;">No devices found</div>';
      return;
    }

    for (const robot of data.robots) {
      // Stash the BLE name so updateRobotSection can gate V3 by SKU
      // ('Go2_*' = no V3, 'G1_*' = probe) without depending on the
      // user's Connect-screen family setting.
      if (robot.address && robot.name) robotNameByAddress.set(robot.address, robot.name);
      this.resultsDiv.appendChild(this.deviceRow(
        '\u{1F916}', robot.name, robot.address, robot.rssi, 'Robot',
      ));
    }
    for (const remote of data.remotes) {
      this.resultsDiv.appendChild(this.deviceRow(
        '\u{1F3AE}', remote.name, remote.address, remote.rssi, 'Remote',
      ));
    }
    this.updateScanRowStates();
  }

  private async handleConnect(_row: HTMLElement, type: string, addr: string, btn: HTMLButtonElement): Promise<void> {
    this.connectingAddrs.add(addr);
    this.setBtnConnecting(btn, true);
    try {
      const path = type === 'Robot'
        ? '/connect?address=' + encodeURIComponent(addr)
        : '/remote/connect?address=' + encodeURIComponent(addr);
      // Connect can take 30-60s if pygatt has to retry a few times
      await this.fetchJSON(path, { method: 'POST' }, 90000);
      this.connectingAddrs.delete(addr);
      await this.refreshStatus();
    } catch (e) {
      this.connectingAddrs.delete(addr);
      this.setBtnConnecting(btn, false);
      const msg = e instanceof Error ? e.message : String(e);
      this.showError(`Connect failed: ${msg}`);
      // Even on frontend error/timeout, the backend retry may have eventually succeeded.
      // Refresh status after a short delay to pick up any connection that went through.
      setTimeout(() => this.refreshStatus(), 2000);
    }
  }

  private setBtnConnecting(btn: HTMLButtonElement, connecting: boolean): void {
    if (connecting) {
      btn.disabled = true;
      btn.style.cursor = 'wait';
      btn.innerHTML = `<span class="bt-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,0.25);border-top-color:#000;border-radius:50%;animation:bt-spin 0.7s linear infinite;"></span>`;
    } else {
      btn.disabled = false;
      btn.style.cursor = 'pointer';
      btn.textContent = 'Connect';
    }
  }

  private showError(msg: string): void {
    const existing = this.content.querySelector('.bt-page-error');
    existing?.remove();
    const err = document.createElement('div');
    err.className = 'bt-page-error';
    err.style.cssText = 'margin-top:8px;padding:8px 10px;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.3);border-radius:5px;color:#ef5350;font-size:11px;';
    err.textContent = msg;
    this.content.appendChild(err);
    setTimeout(() => err.remove(), 5000);
  }

  private deviceRow(icon: string, name: string, address: string, rssi: number | null, type: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bt-device-row';
    row.setAttribute('data-device-addr', address);
    row.setAttribute('data-device-type', type);
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:4px;border-radius:6px;';
    row.innerHTML = `
      <div style="font-size:18px;width:22px;text-align:center;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:12px;">${this.esc(name)} <span style="font-size:10px;color:#666;font-weight:400;">${this.esc(type)}</span></div>
        <div style="font-size:10px;color:#666;font-family:monospace;">${this.esc(address)} · RSSI: ${rssi ?? '?'}</div>
      </div>
      <div data-device-action style="display:flex;align-items:center;"></div>
    `;
    return row;
  }
}

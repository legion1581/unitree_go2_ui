/**
 * Small overlay popover triggered from the nav-bar BT icon.
 * Shows the current BLE connection(s) and offers quick Scan / Disconnect actions.
 */

import { btBackend } from '../../api/bt-backend';
import { getCachedAesKey, setCachedAesKey } from '../../api/aes-key-derive';

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
  // Per-path SN values (only populated when the corresponding fetch path
  // returned). Used to label the displayed SN with its source and to
  // cross-validate F1 vs GCM agreement.
  f1_sn_partial?: string;
  sn_gcm?: string | null;
  sn_v1v2?: string | null;
}
interface RemoteState {
  lx: number; ly: number; rx: number; ry: number;
  buttons: Record<string, boolean>;
  battery: number;
  rssi: number;
}

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

export class BtPopover {
  private overlay: HTMLElement;
  private panel: HTMLElement;
  private onClose: () => void;
  private robotBody: HTMLElement | null = null;
  private remoteBody: HTMLElement | null = null;
  private emptyPlaceholder: HTMLElement | null = null;
  private adapterBody: HTMLElement | null = null;
  private resultsDiv: HTMLElement | null = null;
  private robotStatus: RobotStatus = { connected: false, address: '', protocol: '' };
  private remoteStatus: RemoteStatus = { connected: false, address: '', name: '' };
  private lastRenderedRemoteAddr = '';   // to avoid DOM rebuild when nothing changed
  private lastRenderedRobotAddr = '';
  // Counts every status push the WS subscriber receives. Surface in the
  // popup as a "♥ N" indicator so the user can see the BLE link / status
  // monitor is alive even when no values are changing on screen. Reset
  // each time a fresh BtPopover is constructed (popup open).
  private heartbeatCount = 0;
  private heartbeatLabel: HTMLElement | null = null;
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

  constructor(onClose: () => void) {
    this.onClose = onClose;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9500;display:flex;justify-content:flex-end;align-items:flex-start;padding:54px 18px 0 0;';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    // Block stray Backspace from triggering history.back when focus
    // briefly leaves the AES input (e.g. during a status repaint).
    // Allow it through normally when an editable element is focused.
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const tgt = e.target as HTMLElement | null;
      const tag = (tgt?.tagName || '').toUpperCase();
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable;
      if (!editable) e.preventDefault();
    });

    this.panel = document.createElement('div');
    this.panel.className = 'bt-popover-panel';
    this.panel.style.cssText = 'border-radius:10px;padding:14px 16px;width:420px;max-height:calc(100vh - 80px);overflow-y:auto;min-height:320px;box-sizing:border-box;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,0.5);';
    this.overlay.appendChild(this.panel);

    document.body.appendChild(this.overlay);
    this.buildLayout();

    // Subscribe to backend topics — messages flow in via the shared singleton WS
    this.unsubStatus = btBackend().subscribe('status', (msg: { robot: RobotStatus; remote: RemoteStatus }) => {
      this.heartbeatCount += 1;
      if (this.heartbeatLabel) this.heartbeatLabel.textContent = `\u2665 ${this.heartbeatCount}`;
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

  close(): void {
    this.unsubStatus?.(); this.unsubStatus = null;
    this.unsubAdapters?.(); this.unsubAdapters = null;
    this.unsubRemoteState?.(); this.unsubRemoteState = null;
    this.overlay.remove();
    this.onClose();
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Copy to clipboard';
    btn.style.cssText = 'padding:2px 6px;font-size:10px;border-radius:3px;cursor:pointer;background:transparent;border:1px solid #1f2229;color:#888;font-family:inherit;flex-shrink:0;line-height:1;';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.style.color = '#66bb6a';
        btn.style.borderColor = 'rgba(102,187,106,0.4)';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '#888';
          btn.style.borderColor = '#1f2229';
        }, 1200);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      }
    });
    return btn;
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
    this.panel.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
    header.innerHTML = '<div style="font-size:14px;font-weight:600;color:#e0e0e0;">Bluetooth</div>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;padding:0 6px;';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // Adapter selector
    const adapterSec = this.section('Adapter');
    this.adapterBody = document.createElement('div');
    this.adapterBody.style.minHeight = '28px';
    adapterSec.appendChild(this.adapterBody);
    this.panel.appendChild(adapterSec);

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
    this.panel.appendChild(devicesSec);

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
    this.panel.appendChild(scanSec);
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

    // Connected header + info. The BLE address is also useful as a MAC
    // placeholder when binding the robot — V3 firmware (G1 ≥ 1.5.1)
    // doesn't expose AP MAC over plain V1/V2 BLE, so the bind form needs
    // a paste source. Hand the user a Copy button. The heartbeat label
    // increments on every status push so the user sees the BLE link is
    // alive even when no fields are changing.
    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:#66bb6a;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const addrText = document.createElement('span');
    addrText.innerHTML = `Connected to <strong style="font-family:monospace;">${this.esc(this.robotStatus.address)}</strong> (${this.esc(this.robotStatus.protocol)})`;
    info.appendChild(addrText);
    if (this.robotStatus.address) info.appendChild(this.copyButton(this.robotStatus.address));
    this.heartbeatLabel = document.createElement('span');
    this.heartbeatLabel.style.cssText = 'font-size:11px;color:#888;margin-left:auto;font-family:monospace;';
    this.heartbeatLabel.title = 'Status heartbeats received from BLE backend';
    this.heartbeatLabel.textContent = `\u2665 ${this.heartbeatCount}`;
    info.appendChild(this.heartbeatLabel);
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
      // SN row + a small "(from F1)" / "(F1 ✓ GCM)" / "(V1/V2)" tag so the
      // user can see which path produced the SN. If F1 and GCM disagree we
      // flag it explicitly — that'd indicate either a stale AES key or a
      // truncated F1 read.
      const snRow = this.infoRowWithCopy('SN:', snVal, 'data-sn');
      const tag = this.snSourceTag(rInfo);
      if (tag) {
        const tagSpan = document.createElement('span');
        tagSpan.style.cssText = `font-size:10px;color:${tag.color};margin-left:6px;`;
        tagSpan.textContent = `(${tag.label})`;
        // Insert the tag before the Copy button so the row stays compact.
        const copyBtn = snRow.querySelector('button');
        if (copyBtn) snRow.insertBefore(tagSpan, copyBtn);
        else snRow.appendChild(tagSpan);
      }
      infoRows.appendChild(snRow);
      infoRows.appendChild(this.infoRowWithCopy('AP MAC:', macVal, 'data-mac'));
      // /info returning a real AP MAC on V3 firmware proves the per-device
      // AES key is decrypting frames correctly (the F1 fallback only
      // populates SN, never AP MAC). That's our signal to ungate WiFi.
      this.gcmDecodeWorks = !!macVal;
      this.refreshWifiGate();
      const proto = document.createElement('div');
      proto.setAttribute('data-proto-row', '');
      proto.innerHTML = `<span style="color:#666;">Protocol:</span> ${this.esc(baseProto)}`;
      infoRows.appendChild(proto);
      const hint = document.createElement('div');
      hint.setAttribute('data-v3-info-hint', '');
      hint.style.cssText = 'display:none;font-size:10px;color:#666;font-style:italic;line-height:1.4;margin-top:2px;';
      hint.textContent = 'SN / AP MAC over V3 firmware need GCM-encrypted commands — not yet implemented. Until then: read SN off the robot\u2019s label, and use the BLE address above as the MAC placeholder when binding.';
      infoRows.appendChild(hint);
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

    // V3 info (G1 firmware 1.5.1+; not on Go2): module version + per-device GCM key for WebRTC auth.
    // Both endpoints return `supported:false` on unsupported firmware; in that case we hide the section.
    const v3Rows = document.createElement('div');
    v3Rows.style.cssText = 'font-size:11px;color:#888;margin-bottom:10px;font-family:monospace;line-height:1.6;';
    if (!cached.v3Ver && !cached.v3Gcm) {
      v3Rows.innerHTML = '<div style="color:#666;">V3 (loading…)</div>';
    }
    this.robotBody.appendChild(v3Rows);

    // AES-128 paste field — only useful on V3 firmware. We mount a hidden
    // wrapper here and surface it once V3 is detected. The presence of a
    // valid 32-hex key is what gates the WiFi form below.
    const aesGate = this.buildAesGate();
    aesGate.wrap.style.display = 'none';
    this.robotBody.appendChild(aesGate.wrap);

    const renderV3 = (gcm: V3KeyProbe, ver: V3Probe): void => {
      v3Supported = gcm.supported || ver.supported;
      this.v3Supported = v3Supported;
      this.refreshWifiGate();
      renderProtoRow();
      const hint = infoRows.querySelector<HTMLElement>('[data-v3-info-hint]');
      if (hint && v3Supported) {
        const sn = infoRows.querySelector<HTMLElement>('[data-sn]')?.textContent?.trim();
        const mac = infoRows.querySelector<HTMLElement>('[data-mac]')?.textContent?.trim();
        if (sn === '\u2014' || mac === '\u2014') hint.style.display = '';
      }
      if (!v3Supported) {
        v3Rows.remove();
        aesGate.wrap.remove();
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
      aesGate.wrap.style.display = '';
    };

    if (cached.v3Ver && cached.v3Gcm) renderV3(cached.v3Gcm, cached.v3Ver);
    Promise.all([
      this.fetchJSON<V3KeyProbe>('/v3/gcm-key', undefined, 6000).catch(() => ({ key: null, supported: false }) as V3KeyProbe),
      this.fetchJSON<V3Probe>('/v3/version', undefined, 6000).catch(() => ({ version: null, supported: false }) as V3Probe),
    ]).then(([gcm, ver]) => {
      robotPanelCache.set(currentAddr, { ...(robotPanelCache.get(currentAddr) || {}), v3Gcm: gcm, v3Ver: ver });
      renderV3(gcm, ver);
    });

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
      try {
        const resp = await this.fetchJSON<{ success: boolean; details: Record<string, boolean> }>('/wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password: pwdInput.input.value, ap_mode: apMode, country: countrySelect.select.value }),
        });
        if (resp.success) {
          wifiStatus.textContent = 'WiFi configured';
          wifiStatus.style.color = '#66bb6a';
        } else {
          const failed = Object.entries(resp.details).filter(([, v]) => !v).map(([k]) => k).join(', ');
          wifiStatus.textContent = `Failed: ${failed}`;
          wifiStatus.style.color = '#ff9800';
        }
      } catch (e) {
        wifiStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
        wifiStatus.style.color = '#ef5350';
      } finally {
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
    aesGate.onChange(() => this.refreshWifiGate());
    // Initial gate evaluation — pulls v3Supported / gcmDecodeWorks from
    // whatever the V3 + /info promises have set so far.
    this.aesGateReady = aesGate.isReady;
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

  /** Pick a small "(source)" tag for the SN field that tells the user
   *  which BLE path produced the value, and whether F1 and GCM
   *  cross-validate. Returns null if there's no SN at all. */
  private snSourceTag(rInfo: RobotInfo): { label: string; color: string } | null {
    const f1 = (rInfo.f1_sn_partial || '').trim();
    const gcm = (rInfo.sn_gcm || '').trim();
    const v12 = (rInfo.sn_v1v2 || '').trim();
    if (!f1 && !gcm && !v12) return null;
    if (f1 && gcm) {
      return f1 === gcm
        ? { label: 'F1 ✓ AES', color: '#66bb6a' }
        : { label: `F1≠AES (F1=${f1})`, color: '#e57373' };
    }
    if (gcm) return { label: 'V3 AES', color: '#66bb6a' };
    if (v12) return { label: 'V1/V2', color: '#66bb6a' };
    if (f1) return { label: 'from V3 F1', color: '#888' };
    return null;
  }

  /**
   * Build an AES-128 key gate input. The popup uses this to gate the WiFi
   * form (and, eventually, the SN/MAC fetch path) on V3 firmware. State is
   * not tied to a specific SN here — the BT popup doesn't know the SN until
   * a V3 GCM-encrypted GET_SN response can be decrypted, which is the very
   * thing this key unlocks. We just keep the last entered key in memory and
   * fall back to any cached entry from the Account device tile.
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
              const resp = await fetch(`${BLE_API}/v3/aes-key?key=${encodeURIComponent(v.toLowerCase())}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
              if (!resp.ok) {
                const body = await resp.text();
                status.textContent = `key rejected: ${body.slice(0, 60)}`;
                status.style.color = '#e57373';
                return;
              }
              status.textContent = '✓ key sent';
              status.style.color = '#66bb6a';
              // Always refresh /info — the earlier /info call (fired by
              // the initial render) ran before the backend had the key,
              // so SN/MAC came back empty. refreshInfo() updates only
              // the SN/MAC rows in place, so it doesn't eject focus
              // from the AES input on a user-typed change.
              this.refreshInfo();
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

    // Disconnect
    const disc = this.button('Disconnect Remote', async () => {
      disc.disabled = true;
      this.stopRemoteStream();
      try { await this.fetchJSON('/remote/disconnect', { method: 'POST' }); } catch {}
      this.refreshStatus();
    }, 'danger');
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
    const existing = this.panel.querySelector('.bt-popover-error');
    existing?.remove();
    const err = document.createElement('div');
    err.className = 'bt-popover-error';
    err.style.cssText = 'margin-top:8px;padding:8px 10px;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.3);border-radius:5px;color:#ef5350;font-size:11px;';
    err.textContent = msg;
    this.panel.appendChild(err);
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

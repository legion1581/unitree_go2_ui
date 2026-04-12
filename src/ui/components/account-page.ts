/**
 * Account Manager page — 4 tabs: Devices, Info, Account, Debug
 * Follows the same pattern as StatusPage / ServicesPage.
 */

import { cloudApi, type RobotDevice, type UserInfo, type FirmwareInfo, type TutorialGroup, type ChangelogEntry, type AppVersionInfo } from '../../api/unitree-cloud';

type Tab = 'devices' | 'info' | 'account' | 'debug';

export class AccountPage {
  private container: HTMLElement;
  private content: HTMLElement;
  private currentTab: Tab = 'devices';
  private tabButtons: Map<Tab, HTMLElement> = new Map();

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
    title.textContent = 'Account Manager';
    header.appendChild(title);
    this.container.appendChild(header);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'acct-tab-bar';
    for (const tab of ['devices', 'info', 'account', 'debug'] as Tab[]) {
      const btn = document.createElement('button');
      btn.className = 'acct-tab-btn';
      btn.textContent = tab === 'devices' ? 'Devices' : tab === 'info' ? 'Info' : tab === 'account' ? 'Account' : 'Debug';
      btn.addEventListener('click', () => this.switchTab(tab));
      tabBar.appendChild(btn);
      this.tabButtons.set(tab, btn);
    }
    this.container.appendChild(tabBar);

    // Content
    this.content = document.createElement('div');
    this.content.className = 'page-content';
    this.container.appendChild(this.content);

    parent.appendChild(this.container);

    if (!cloudApi.isLoggedIn) {
      cloudApi.loadSession();
    }
    this.switchTab(cloudApi.isLoggedIn ? 'devices' : 'account');
  }

  private switchTab(tab: Tab): void {
    this.currentTab = tab;
    this.tabButtons.forEach((btn, t) => btn.classList.toggle('active', t === tab));
    this.content.innerHTML = '';
    this.content.scrollTop = 0;

    if (tab === 'account') { this.renderAccountTab(); return; }
    if (!cloudApi.isLoggedIn) { this.renderLoginForm(); return; }

    if (tab === 'devices') this.renderDevicesTab();
    else if (tab === 'info') this.renderInfoTab();
    else if (tab === 'debug') this.renderDebugTab();
  }

  // ─── Account Tab ─────────────────────────────────────────────────

  private renderAccountTab(): void {
    if (!cloudApi.isLoggedIn) {
      this.renderLoginForm();
      return;
    }

    const s = this.section('User Info');
    if (cloudApi.user) {
      const u = cloudApi.user;
      if (u.avatar) {
        const img = document.createElement('img');
        img.src = u.avatar;
        img.style.cssText = 'width:48px;height:48px;border-radius:50%;margin-bottom:8px;';
        s.appendChild(img);
      }
      this.infoRow(s, 'Nickname', u.nickname);
      this.infoRow(s, 'Email', u.email);
      this.infoRow(s, 'UID', u.uid);
      if (u.mobile) this.infoRow(s, 'Mobile', u.mobile);
    } else {
      this.infoRow(s, 'Status', 'Logged in (token)');
    }
    this.content.appendChild(s);

    // Refresh info button
    const refreshBtn = this.button('Refresh User Info', async () => {
      try {
        await cloudApi.getUserInfo();
        this.switchTab('account');
      } catch (e) { alert(String(e)); }
    });
    this.content.appendChild(refreshBtn);

    // Logout
    const logoutSection = this.section('Session');
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'acct-btn acct-btn-danger';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', () => {
      cloudApi.logout();
      this.switchTab('account');
    });
    logoutSection.appendChild(logoutBtn);
    this.content.appendChild(logoutSection);
  }

  private renderLoginForm(): void {
    const s = this.section('Login');
    const form = document.createElement('div');
    form.className = 'acct-form';

    const emailInput = this.input('Email', 'email');
    const pwdInput = this.input('Password', 'password', 'password');
    form.appendChild(emailInput.wrapper);
    form.appendChild(pwdInput.wrapper);

    const loginBtn = document.createElement('button');
    loginBtn.className = 'acct-btn acct-btn-primary';
    loginBtn.textContent = 'Login';
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Logging in...';
      try {
        await cloudApi.loginEmail(emailInput.input.value, pwdInput.input.value);
        this.switchTab('devices');
      } catch (e: unknown) {
        alert(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
      }
    });
    form.appendChild(loginBtn);

    // Token login
    const tokenLabel = document.createElement('div');
    tokenLabel.style.cssText = 'font-size:11px;color:#555;margin-top:16px;text-align:center;';
    tokenLabel.textContent = '— or paste access token —';
    form.appendChild(tokenLabel);

    const tokenInput = this.input('Access Token', 'text');
    form.appendChild(tokenInput.wrapper);

    const tokenBtn = document.createElement('button');
    tokenBtn.className = 'acct-btn';
    tokenBtn.style.cssText = 'background:transparent;border:1px solid #333;color:#aaa;';
    tokenBtn.textContent = 'Login with Token';
    tokenBtn.addEventListener('click', () => {
      const t = tokenInput.input.value.trim();
      if (!t) return;
      cloudApi.setAccessToken(t);
      cloudApi.saveSession();
      this.switchTab('devices');
    });
    form.appendChild(tokenBtn);

    s.appendChild(form);
    this.content.appendChild(s);
  }

  // ─── Devices Tab ─────────────────────────────────────────────────

  private async renderDevicesTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading devices...</div>';

    try {
      const devices = await cloudApi.listDevices();
      this.content.innerHTML = '';

      // Header with Add button
      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
      const h = document.createElement('div');
      h.style.cssText = 'font-size:15px;font-weight:600;color:#fff;';
      h.textContent = `My Robots (${devices.length})`;
      hdr.appendChild(h);
      const addBtn = document.createElement('button');
      addBtn.className = 'acct-btn acct-btn-primary';
      addBtn.style.cssText = 'padding:4px 12px;font-size:12px;';
      addBtn.textContent = '+ Add';
      addBtn.addEventListener('click', () => this.showBindForm());
      hdr.appendChild(addBtn);
      this.content.appendChild(hdr);

      for (const dev of devices) {
        const card = await this.renderDeviceCard(dev);
        this.content.appendChild(card);
      }
      if (!devices.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#555;text-align:center;padding:40px 0;';
        empty.textContent = 'No robots bound to your account.';
        this.content.appendChild(empty);
      }
    } catch (e) {
      this.content.innerHTML = `<div style="color:#ef5350;padding:20px;">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  }

  private async renderDeviceCard(dev: RobotDevice): Promise<HTMLElement> {
    const card = this.section(dev.alias || dev.sn);

    // Online status
    let online: boolean | null = null;
    try { online = await cloudApi.getDeviceOnlineStatus(dev.sn); } catch { /* ignore */ }
    const badge = document.createElement('span');
    badge.style.cssText = `position:absolute;top:12px;right:14px;font-size:11px;padding:2px 8px;border-radius:8px;font-weight:600;${
      online === true ? 'background:#1b5e20;color:#a5d6a7;' :
      online === false ? 'background:#424242;color:#888;' :
      'background:#333;color:#666;'
    }`;
    badge.textContent = online === true ? 'Online' : online === false ? 'Offline' : '?';
    card.style.position = 'relative';
    card.appendChild(badge);

    this.infoRow(card, 'SN', dev.sn, true);
    this.infoRow(card, 'Series', dev.series);
    if (dev.model) this.infoRow(card, 'Model', dev.model);
    if (dev.connIp) this.infoRow(card, 'IP', dev.connIp, true);
    if (dev.connMode) this.infoRow(card, 'Mode', dev.connMode);
    if (dev.key) this.infoRow(card, 'GCM Key', dev.key.length > 32 ? dev.key.slice(0, 32) + '...' : dev.key, true);

    // Firmware updates
    try {
      const fw = await cloudApi.listFirmwareUpdates(dev.sn);
      if (fw.length) {
        const fwDiv = document.createElement('div');
        fwDiv.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #1f2229;';
        for (const f of fw) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
          row.innerHTML = `<span style="color:#888;font-size:12px;font-family:monospace;">${f.ownVersion}</span>
            <span style="color:#555;">→</span>
            <span style="color:#66bb6a;font-weight:600;font-family:monospace;">${f.version}</span>`;
          if (f.download) {
            const dl = document.createElement('a');
            dl.href = cloudApi.getFirmwareDownloadUrl(f.download);
            dl.target = '_blank';
            dl.referrerPolicy = 'no-referrer';
            dl.style.cssText = 'font-size:11px;color:#4fc3f7;margin-left:auto;';
            dl.textContent = 'Download';
            row.appendChild(dl);
          }
          fwDiv.appendChild(row);
        }
        card.appendChild(fwDiv);
      }
    } catch { /* ignore */ }

    // GPS
    try {
      const loc = await cloudApi.getDeviceLocation(dev.sn);
      if (loc) {
        const gpsDiv = document.createElement('div');
        gpsDiv.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #1f2229;font-size:12px;';
        const gpsOn = loc.gpsEnable === 1;
        gpsDiv.innerHTML = `<span style="color:#888;">GPS:</span> <span style="color:${gpsOn ? '#66bb6a' : '#888'};">${gpsOn ? 'Enabled' : 'Disabled'}</span>`;
        if (loc.latitude && loc.longitude && loc.latitude !== '' && loc.longitude !== '') {
          gpsDiv.innerHTML += ` <span style="color:#555;font-family:monospace;">(${loc.latitude}, ${loc.longitude})</span>`;
        }
        card.appendChild(gpsDiv);
      }
    } catch { /* ignore */ }

    return card;
  }

  private showBindForm(): void {
    this.content.innerHTML = '';
    const s = this.section('Bind New Robot');
    const form = document.createElement('div');
    form.className = 'acct-form';
    const snInput = this.input('Serial Number', 'text');
    const aliasInput = this.input('Alias (optional)', 'text');
    form.appendChild(snInput.wrapper);
    form.appendChild(aliasInput.wrapper);
    const btn = this.button('Bind Robot', async () => {
      try {
        await cloudApi.bindDevice(snInput.input.value.trim(), aliasInput.input.value.trim());
        this.switchTab('devices');
      } catch (e) { alert(String(e)); }
    });
    form.appendChild(btn);
    const cancelBtn = this.button('Cancel', () => this.switchTab('devices'));
    cancelBtn.style.background = 'transparent';
    cancelBtn.style.border = '1px solid #333';
    cancelBtn.style.color = '#888';
    form.appendChild(cancelBtn);
    s.appendChild(form);
    this.content.appendChild(s);
  }

  // ─── Info Tab ────────────────────────────────────────────────────

  private async renderInfoTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading...</div>';

    try {
      const [appVer, tutorials, changelog, notices] = await Promise.allSettled([
        cloudApi.getAppVersion(),
        cloudApi.getTutorials(),
        cloudApi.getChangelog(),
        cloudApi.getNotices(),
      ]);
      this.content.innerHTML = '';

      // App version
      const ver = appVer.status === 'fulfilled' ? appVer.value : null;
      if (ver) {
        const s = this.section('App Version');
        this.infoRow(s, 'Latest', ver.VersionName, false, '#66bb6a');
        this.infoRow(s, 'Code', String(ver.VersionCode), true);
        if (ver.DownloadUrl) {
          const dl = document.createElement('a');
          dl.href = ver.DownloadUrl;
          dl.target = '_blank';
          dl.referrerPolicy = 'no-referrer';
          dl.className = 'acct-btn acct-btn-primary';
          dl.style.cssText = 'display:inline-block;margin-top:8px;padding:4px 12px;font-size:12px;text-decoration:none;';
          dl.textContent = `Download ${ver.DownloadUrl.split('/').pop()}`;
          s.appendChild(dl);
        }
        this.content.appendChild(s);
      }

      // Notices
      const noticeData = notices.status === 'fulfilled' ? notices.value : [];
      if (noticeData.length) {
        const s = this.section('Announcements');
        for (const n of noticeData) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:6px 0;border-bottom:1px solid #1a1d23;';
          row.innerHTML = `<div style="font-weight:600;font-size:13px;">${this.esc(n.title)}</div>`;
          if (n.content) row.innerHTML += `<div style="font-size:12px;color:#888;margin-top:2px;">${this.esc(n.content)}</div>`;
          s.appendChild(row);
        }
        this.content.appendChild(s);
      }

      // Tutorials
      const tutData = tutorials.status === 'fulfilled' ? tutorials.value : [];
      for (const group of tutData) {
        const s = this.section(group.name);
        for (const t of group.tutorials) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #151820;align-items:center;';
          if (t.cover) {
            row.innerHTML = `<img src="${this.esc(t.cover)}" style="width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;">`;
          }
          const info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0;';
          info.innerHTML = `<div style="font-size:13px;font-weight:500;">${this.esc(t.title)}</div>`;
          if (t.duration) info.innerHTML += `<div style="font-size:11px;color:#666;">${(t.duration / 60).toFixed(1)} min</div>`;
          row.appendChild(info);
          if (t.url) {
            const a = document.createElement('a');
            a.href = t.url;
            a.target = '_blank';
            a.style.cssText = 'font-size:11px;color:#4fc3f7;flex-shrink:0;';
            a.textContent = 'Watch';
            row.appendChild(a);
          }
          s.appendChild(row);
        }
        this.content.appendChild(s);
      }

      // Changelog
      const clData = changelog.status === 'fulfilled' ? changelog.value : [];
      if (clData.length) {
        const s = this.section('Changelog');
        for (const v of clData) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid #1a1d23;';
          row.innerHTML = `<span style="color:#4fc3f7;font-weight:700;min-width:50px;">${this.esc(v.title)}</span>
            <span style="color:#555;font-size:12px;">${this.esc(v.publishTime)}</span>`;
          if (v.link) {
            const a = document.createElement('a');
            a.href = v.link;
            a.target = '_blank';
            a.style.cssText = 'font-size:12px;color:#4fc3f7;margin-left:auto;';
            a.textContent = 'Details';
            row.appendChild(a);
          }
          s.appendChild(row);
        }
        this.content.appendChild(s);
      }
    } catch (e) {
      this.content.innerHTML = `<div style="color:#ef5350;padding:20px;">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  }

  // ─── Debug Tab ───────────────────────────────────────────────────

  private renderDebugTab(): void {
    const s = this.section('Raw API Request');
    const form = document.createElement('div');
    form.className = 'acct-form';

    // Method select
    const methodWrap = document.createElement('div');
    methodWrap.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
    const methodSel = document.createElement('select');
    methodSel.style.cssText = 'width:80px;padding:8px;background:#0a0c10;border:1px solid #2a2d35;color:#fff;border-radius:6px;';
    methodSel.innerHTML = '<option>GET</option><option>POST</option>';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = 'endpoint/path';
    pathInput.style.cssText = 'flex:1;padding:8px;background:#0a0c10;border:1px solid #2a2d35;color:#4fc3f7;border-radius:6px;font-family:monospace;font-size:13px;';
    methodWrap.appendChild(methodSel);
    methodWrap.appendChild(pathInput);
    form.appendChild(methodWrap);

    // Params
    const paramsInput = document.createElement('textarea');
    paramsInput.placeholder = 'key=value (one per line)';
    paramsInput.rows = 4;
    paramsInput.style.cssText = 'width:100%;padding:8px;background:#0a0c10;border:1px solid #2a2d35;color:#e0e0e0;border-radius:6px;font-family:monospace;font-size:12px;resize:vertical;';
    form.appendChild(paramsInput);

    const sendBtn = this.button('Send Request', async () => {
      const params: Record<string, string> = {};
      for (const line of paramsInput.value.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes('=')) {
          const [k, ...v] = trimmed.split('=');
          params[k.trim()] = v.join('=').trim();
        }
      }
      resultEl.textContent = 'Loading...';
      resultEl.style.color = '#888';
      try {
        const resp = await cloudApi.rawRequest(methodSel.value, pathInput.value.trim(), Object.keys(params).length ? params : undefined);
        resultEl.textContent = JSON.stringify(resp, null, 2);
        resultEl.style.color = resp.code === 100 ? '#a5d6a7' : '#ef9a9a';
      } catch (e) {
        resultEl.textContent = String(e);
        resultEl.style.color = '#ef5350';
      }
    });
    form.appendChild(sendBtn);
    s.appendChild(form);
    this.content.appendChild(s);

    // Quick endpoints
    const endpoints = [
      ['GET', 'user/info', ''],
      ['GET', 'device/bind/list', ''],
      ['GET', 'device/online/status', 'sn='],
      ['GET', 'device/location', 'sn='],
      ['GET', 'device/network', 'sn='],
      ['POST', 'v1/firmware/package/upgrade/list', 'sn='],
      ['POST', 'firmware/package/version', 'sn='],
      ['GET', 'app/version', 'platform=Android'],
      ['GET', 'tutorial/list', 'appName=Go2'],
      ['GET', 'v2/tutorial/list', 'appName=Go2'],
      ['GET', 'app/version/intro/list', 'lastId=0'],
      ['GET', 'app/notice/list', ''],
      ['GET', 'system/pubKey', ''],
      ['GET', 'flow/card/info', 'sn='],
      ['GET', 'device/flow/usage', 'sn=\nyear=2026\nmonth=4'],
      ['POST', 'device/wallet', 'sn='],
      ['POST', 'device/share/list', 'sn='],
      ['GET', 'advertisements', 'position=1'],
      ['GET', 'agreement/version/latest', ''],
      ['GET', 'exercise/data/summary', ''],
    ];

    const qs = this.section('Quick Endpoints');
    for (const [m, p, par] of endpoints) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0;cursor:pointer;border-bottom:1px solid #151820;';
      row.innerHTML = `<span style="font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;${m === 'GET' ? 'background:#1b5e20;color:#a5d6a7;' : 'background:#e65100;color:#ffcc80;'}">${m}</span><span style="font-size:12px;color:#4fc3f7;font-family:monospace;">${p}</span>`;
      row.addEventListener('click', () => {
        methodSel.value = m;
        pathInput.value = p;
        paramsInput.value = par;
        this.content.scrollTop = 0;
      });
      qs.appendChild(row);
    }
    this.content.appendChild(qs);

    // Result area
    const resultSection = this.section('Response');
    const resultEl = document.createElement('pre');
    resultEl.style.cssText = 'font-family:monospace;font-size:12px;color:#888;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;';
    resultEl.textContent = '(no request sent yet)';
    resultSection.appendChild(resultEl);
    this.content.appendChild(resultSection);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private section(title: string): HTMLElement {
    const s = document.createElement('div');
    s.className = 'status-section';
    const t = document.createElement('div');
    t.className = 'status-section-title';
    t.textContent = title;
    s.appendChild(t);
    return s;
  }

  private infoRow(parent: HTMLElement, label: string, value: string, mono = false, color = ''): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:3px 0;font-size:13px;';
    row.innerHTML = `<span style="color:#888;min-width:80px;">${this.esc(label)}</span><span style="color:${color || '#e0e0e0'};${mono ? 'font-family:monospace;font-size:12px;' : ''}word-break:break-all;">${this.esc(value || '-')}</span>`;
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

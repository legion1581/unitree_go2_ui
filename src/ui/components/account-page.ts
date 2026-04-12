/**
 * Account Manager page — 4 tabs: Devices, Info, Account, Debug
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
    const tabLabels: Record<Tab, string> = { devices: 'Devices', info: 'Info', account: 'Account', debug: 'Debug' };
    for (const [tab, label] of Object.entries(tabLabels) as [Tab, string][]) {
      const btn = document.createElement('button');
      btn.className = 'acct-tab-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => this.switchTab(tab));
      tabBar.appendChild(btn);
      this.tabButtons.set(tab, btn);
    }
    this.container.appendChild(tabBar);

    this.content = document.createElement('div');
    this.content.className = 'page-content';
    this.container.appendChild(this.content);
    parent.appendChild(this.container);

    if (!cloudApi.isLoggedIn) cloudApi.loadSession();
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

  // ════════════════════════════════════════════════════════════════════
  // ACCOUNT TAB (rich)
  // ════════════════════════════════════════════════════════════════════

  private renderAccountTab(): void {
    if (!cloudApi.isLoggedIn) { this.renderLoginForm(); return; }

    // User profile card
    const profile = this.section('Profile');
    if (cloudApi.user) {
      const u = cloudApi.user;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:12px;';
      if (u.avatar) {
        row.innerHTML = `<img src="${this.esc(u.avatar)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #2a2d35;">`;
      } else {
        row.innerHTML = `<div style="width:56px;height:56px;border-radius:50%;background:#2a2d35;display:flex;align-items:center;justify-content:center;font-size:22px;color:#666;">${(u.nickname || '?')[0].toUpperCase()}</div>`;
      }
      const info = document.createElement('div');
      info.innerHTML = `<div style="font-size:16px;font-weight:600;">${this.esc(u.nickname)}</div>
        <div style="font-size:12px;color:#666;">${this.esc(u.email)}</div>
        <div style="font-size:11px;color:#555;">UID: ${this.esc(u.uid)}</div>`;
      row.appendChild(info);
      profile.appendChild(row);
      if (u.mobile) this.infoRow(profile, 'Mobile', u.mobile);
      this.infoRow(profile, 'Gender', u.gender === 1 ? 'Male' : u.gender === 2 ? 'Female' : 'Not set');
      if (u.roles?.length) this.infoRow(profile, 'Roles', u.roles.join(', '));
    }
    this.content.appendChild(profile);

    // Edit nickname
    const edit = this.section('Edit Profile');
    const nickInput = this.input('Nickname', 'text');
    if (cloudApi.user?.nickname) nickInput.input.value = cloudApi.user.nickname;
    edit.appendChild(nickInput.wrapper);
    edit.appendChild(this.button('Save Profile', async () => {
      try {
        await cloudApi.updateUserInfo({ nickname: nickInput.input.value.trim() });
        await cloudApi.getUserInfo();
        this.switchTab('account');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(edit);

    // Change password
    const pw = this.section('Change Password');
    const oldPw = this.input('Current Password', 'password', 'password');
    const newPw = this.input('New Password', 'password', 'password');
    pw.appendChild(oldPw.wrapper);
    pw.appendChild(newPw.wrapper);
    pw.appendChild(this.button('Change Password', async () => {
      try {
        await cloudApi.changePassword(oldPw.input.value, newPw.input.value);
        alert('Password changed');
        oldPw.input.value = '';
        newPw.input.value = '';
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(pw);

    // Region
    const region = this.section('Region');
    const regionInput = this.input('Region Code', 'text');
    regionInput.input.placeholder = 'US';
    region.appendChild(regionInput.wrapper);
    region.appendChild(this.button('Set Region', async () => {
      try {
        await cloudApi.post('user/setRegion', { region: regionInput.input.value.trim() });
        alert('Region updated');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(region);

    // Refresh / Logout
    const session = this.section('Session');
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'acct-btn';
    refreshBtn.style.cssText = 'background:#1a1d23;color:#4fc3f7;border:1px solid #2a2d35;flex:1;';
    refreshBtn.textContent = 'Refresh Info';
    refreshBtn.addEventListener('click', async () => {
      try { await cloudApi.getUserInfo(); this.switchTab('account'); } catch (e) { alert(String(e)); }
    });
    btnRow.appendChild(refreshBtn);
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'acct-btn acct-btn-danger';
    logoutBtn.style.flex = '1';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', () => { cloudApi.logout(); this.switchTab('account'); });
    btnRow.appendChild(logoutBtn);
    session.appendChild(btnRow);
    this.content.appendChild(session);
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
      } catch (e) { alert(`Login failed: ${e instanceof Error ? e.message : String(e)}`); }
      finally { loginBtn.disabled = false; loginBtn.textContent = 'Login'; }
    });
    form.appendChild(loginBtn);

    const sep = document.createElement('div');
    sep.style.cssText = 'font-size:11px;color:#555;margin:16px 0 8px;text-align:center;';
    sep.textContent = '— or paste access token —';
    form.appendChild(sep);

    const tokenInput = this.input('Access Token', 'text');
    form.appendChild(tokenInput.wrapper);
    const tokenBtn = document.createElement('button');
    tokenBtn.className = 'acct-btn';
    tokenBtn.style.cssText = 'background:transparent;border:1px solid #2a2d35;color:#888;';
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

  // ════════════════════════════════════════════════════════════════════
  // DEVICES TAB (tiles with detail + share)
  // ════════════════════════════════════════════════════════════════════

  private async renderDevicesTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading devices...</div>';
    try {
      const devices = await cloudApi.listDevices();
      this.content.innerHTML = '';

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

      // Tile grid
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;';

      // Fetch online statuses in parallel
      const statuses = await Promise.allSettled(devices.map(d => cloudApi.rawRequest('GET', 'device/online/status', { sn: d.sn })));

      for (let i = 0; i < devices.length; i++) {
        const dev = devices[i];
        const statusResp = statuses[i];
        let online: boolean | null = null;
        if (statusResp.status === 'fulfilled' && statusResp.value.code === 100) {
          online = !!statusResp.value.data;
        }
        grid.appendChild(this.buildDeviceTile(dev, online));
      }
      this.content.appendChild(grid);

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

  private buildDeviceTile(dev: RobotDevice, online: boolean | null): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'status-section';
    tile.style.cssText += 'position:relative;cursor:default;';

    // Online badge
    const badge = document.createElement('span');
    badge.style.cssText = `position:absolute;top:10px;right:12px;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:700;${
      online === true ? 'background:#1b5e20;color:#a5d6a7;' :
      online === false ? 'background:#333;color:#666;' :
      'background:#222;color:#555;'
    }`;
    badge.textContent = online === true ? 'Online' : online === false ? 'Offline' : '—';
    tile.appendChild(badge);

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;padding-right:60px;';
    title.textContent = dev.alias || dev.sn;
    tile.appendChild(title);

    this.infoRow(tile, 'SN', dev.sn, true);
    this.infoRow(tile, 'Series', dev.series);
    if (dev.model) this.infoRow(tile, 'Model', dev.model);
    if (dev.connIp) this.infoRow(tile, 'IP', dev.connIp, true);
    if (dev.connMode) this.infoRow(tile, 'Mode', dev.connMode);
    if (dev.key) this.infoRow(tile, 'GCM Key', dev.key.length > 32 ? dev.key.slice(0, 32) + '...' : dev.key, true);

    // Buttons row
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const detailBtn = document.createElement('button');
    detailBtn.className = 'acct-btn';
    detailBtn.style.cssText = 'flex:1;padding:6px;font-size:12px;background:#1a1d23;color:#4fc3f7;border:1px solid #2a2d35;';
    detailBtn.textContent = 'Details';
    detailBtn.addEventListener('click', () => this.showDeviceDetail(dev));
    btns.appendChild(detailBtn);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'acct-btn';
    shareBtn.style.cssText = 'flex:1;padding:6px;font-size:12px;background:#1a1d23;color:#888;border:1px solid #2a2d35;';
    shareBtn.textContent = 'Share';
    shareBtn.addEventListener('click', () => this.showShareView(dev));
    btns.appendChild(shareBtn);

    tile.appendChild(btns);
    return tile;
  }

  private async showDeviceDetail(dev: RobotDevice): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading...</div>';

    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));

    try {
      this.content.innerHTML = '';
      this.content.appendChild(backLink);

      // Device info
      const s = this.section(dev.alias || dev.sn);
      this.infoRow(s, 'Serial Number', dev.sn, true);
      this.infoRow(s, 'Series', dev.series);
      if (dev.model) this.infoRow(s, 'Model', dev.model);
      if (dev.mac) this.infoRow(s, 'MAC', dev.mac, true);
      if (dev.connIp) this.infoRow(s, 'IP', dev.connIp, true);
      if (dev.connMode) this.infoRow(s, 'Mode', dev.connMode);
      if (dev.code) this.infoRow(s, 'Code', dev.code, true);
      this.infoRow(s, 'Owner', dev.own === 1 ? 'Yes' : 'Shared');
      if (dev.key) this.infoRow(s, 'GCM Key', dev.key, true);
      if (dev.remark) this.infoRow(s, 'Remark', dev.remark);
      this.content.appendChild(s);

      // Edit
      const edit = this.section('Edit');
      const aliasInput = this.input('Alias', 'text');
      aliasInput.input.value = dev.alias;
      const remarkInput = this.input('Remark', 'text');
      remarkInput.input.value = dev.remark;
      edit.appendChild(aliasInput.wrapper);
      edit.appendChild(remarkInput.wrapper);
      edit.appendChild(this.button('Save', async () => {
        try {
          await cloudApi.updateDevice(dev.sn, aliasInput.input.value.trim(), remarkInput.input.value.trim());
          alert('Updated');
        } catch (e) { alert(String(e)); }
      }));
      this.content.appendChild(edit);

      // Firmware
      try {
        const fw = await cloudApi.listFirmwareUpdates(dev.sn);
        if (fw.length) {
          const fws = this.section('Firmware Updates');
          for (const f of fw) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:8px 0;border-bottom:1px solid #1a1d23;';
            row.innerHTML = `<div><span style="color:#888;font-family:monospace;">${this.esc(f.ownVersion)}</span> <span style="color:#555;">→</span> <span style="color:#66bb6a;font-weight:700;font-family:monospace;">${this.esc(f.version)}</span></div>`;
            if (f.description) row.innerHTML += `<div style="font-size:12px;color:#888;margin-top:4px;white-space:pre-wrap;">${this.esc(f.description)}</div>`;
            if (f.md5) row.innerHTML += `<div style="font-size:11px;color:#555;font-family:monospace;margin-top:2px;">MD5: ${this.esc(f.md5)}</div>`;
            if (f.download) {
              const url = cloudApi.getFirmwareDownloadUrl(f.download);
              row.innerHTML += `<a href="${this.esc(url)}" target="_blank" referrerpolicy="no-referrer" style="font-size:12px;color:#4fc3f7;display:block;margin-top:4px;">Download .upk</a>`;
              row.innerHTML += `<div style="font-size:10px;color:#444;font-family:monospace;margin-top:2px;word-break:break-all;">${this.esc(url)}</div>`;
            }
            fws.appendChild(row);
          }
          this.content.appendChild(fws);
        }
      } catch { /* ignore */ }

      // GPS
      try {
        const loc = await cloudApi.getDeviceLocation(dev.sn);
        const gps = this.section('GPS Location');
        const gpsOn = loc?.gpsEnable === 1;
        const statusRow = document.createElement('div');
        statusRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';
        statusRow.innerHTML = `<span style="font-size:11px;padding:2px 8px;border-radius:8px;font-weight:700;${gpsOn ? 'background:#1b5e20;color:#a5d6a7;' : 'background:#333;color:#666;'}">${gpsOn ? 'Enabled' : 'Disabled'}</span>`;
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'acct-btn';
        toggleBtn.style.cssText = `padding:3px 10px;font-size:11px;${gpsOn ? 'background:transparent;border:1px solid #333;color:#888;' : 'background:#4fc3f7;color:#000;border:none;'}`;
        toggleBtn.textContent = gpsOn ? 'Disable' : 'Enable GPS';
        toggleBtn.addEventListener('click', async () => {
          try {
            await cloudApi.updateDeviceGps(dev.sn, !gpsOn);
            this.showDeviceDetail(dev);
          } catch (e) { alert(String(e)); }
        });
        statusRow.appendChild(toggleBtn);
        gps.appendChild(statusRow);

        if (loc?.latitude && loc.longitude && loc.latitude !== '' && loc.longitude !== '') {
          this.infoRow(gps, 'Latitude', loc.latitude, true);
          this.infoRow(gps, 'Longitude', loc.longitude, true);
          if (loc.gpsTimestamp && loc.gpsTimestamp !== '0') this.infoRow(gps, 'Timestamp', loc.gpsTimestamp);
        } else {
          const msg = document.createElement('div');
          msg.style.cssText = 'font-size:12px;color:#555;';
          msg.textContent = gpsOn ? 'No GPS fix yet.' : 'Enable GPS to track location.';
          gps.appendChild(msg);
        }
        this.content.appendChild(gps);
      } catch { /* ignore */ }

      // Danger zone
      const danger = this.section('Danger Zone');
      danger.style.borderColor = '#c62828';
      const unbindBtn = document.createElement('button');
      unbindBtn.className = 'acct-btn acct-btn-danger';
      unbindBtn.textContent = 'Unbind Robot';
      unbindBtn.addEventListener('click', async () => {
        if (!confirm(`Unbind ${dev.sn}?`)) return;
        try {
          await cloudApi.unbindDevice(dev.sn);
          this.switchTab('devices');
        } catch (e) { alert(String(e)); }
      });
      danger.appendChild(unbindBtn);
      this.content.appendChild(danger);
    } catch (e) {
      this.content.innerHTML = '';
      this.content.appendChild(backLink);
      this.content.innerHTML += `<div style="color:#ef5350;padding:20px;">Error: ${e instanceof Error ? e.message : String(e)}</div>`;
    }
  }

  private async showShareView(dev: RobotDevice): Promise<void> {
    this.content.innerHTML = '';

    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));
    this.content.appendChild(backLink);

    // Share form
    const s = this.section(`Share ${dev.alias || dev.sn}`);
    const accountInput = this.input('Account (email or phone)', 'text');
    s.appendChild(accountInput.wrapper);
    s.appendChild(this.button('Share', async () => {
      const acct = accountInput.input.value.trim();
      if (!acct) return;
      try {
        await cloudApi.shareDevice(dev.sn, acct);
        alert(`Shared with ${acct}`);
        this.showShareView(dev);
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(s);

    // Current shares
    try {
      const shares = await cloudApi.listShares(dev.sn);
      if (shares.length) {
        const list = this.section('Current Shares');
        for (const sh of shares) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a1d23;';
          row.innerHTML = `<span style="font-size:13px;">${this.esc(sh.nickname || sh.uid)}</span>`;
          const delBtn = document.createElement('button');
          delBtn.className = 'acct-btn acct-btn-danger';
          delBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
          delBtn.textContent = 'Remove';
          delBtn.addEventListener('click', async () => {
            try {
              await cloudApi.deleteShare(dev.sn, sh.shareUid || sh.uid);
              this.showShareView(dev);
            } catch (e) { alert(String(e)); }
          });
          row.appendChild(delBtn);
          list.appendChild(row);
        }
        this.content.appendChild(list);
      }
    } catch { /* ignore */ }
  }

  private showBindForm(): void {
    this.content.innerHTML = '';
    const backLink = document.createElement('button');
    backLink.className = 'acct-btn';
    backLink.style.cssText = 'background:transparent;color:#4fc3f7;border:none;padding:0;font-size:13px;margin-bottom:12px;cursor:pointer;';
    backLink.textContent = '← Back to devices';
    backLink.addEventListener('click', () => this.switchTab('devices'));
    this.content.appendChild(backLink);

    const s = this.section('Bind New Robot');
    const snInput = this.input('Serial Number', 'text');
    const aliasInput = this.input('Alias (optional)', 'text');
    s.appendChild(snInput.wrapper);
    s.appendChild(aliasInput.wrapper);
    s.appendChild(this.button('Bind Robot', async () => {
      try {
        await cloudApi.bindDevice(snInput.input.value.trim(), aliasInput.input.value.trim());
        this.switchTab('devices');
      } catch (e) { alert(String(e)); }
    }));
    this.content.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════
  // INFO TAB
  // ════════════════════════════════════════════════════════════════════

  private async renderInfoTab(): Promise<void> {
    this.content.innerHTML = '<div style="color:#666;padding:20px;">Loading...</div>';

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
    if (Array.isArray(noticeData) && noticeData.length) {
      const s = this.section('Announcements');
      for (const n of noticeData) {
        if (!n || typeof n !== 'object') continue;
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 0;border-bottom:1px solid #1a1d23;';
        row.innerHTML = `<div style="font-weight:600;font-size:13px;">${this.esc(n.title || '')}</div>`;
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
        if (!t || typeof t !== 'object') continue;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #151820;align-items:center;';
        if (t.cover) row.innerHTML = `<img src="${this.esc(t.cover)}" style="width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;">`;
        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        info.innerHTML = `<div style="font-size:13px;font-weight:500;">${this.esc(t.title || '')}</div>`;
        if (t.duration) info.innerHTML += `<div style="font-size:11px;color:#666;">${(t.duration / 60).toFixed(1)} min</div>`;
        row.appendChild(info);
        if (t.url) {
          const a = document.createElement('a');
          a.href = t.url; a.target = '_blank';
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
          a.href = v.link; a.target = '_blank';
          a.style.cssText = 'font-size:12px;color:#4fc3f7;margin-left:auto;';
          a.textContent = 'Details';
          row.appendChild(a);
        }
        s.appendChild(row);
      }
      this.content.appendChild(s);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // DEBUG TAB
  // ════════════════════════════════════════════════════════════════════

  private renderDebugTab(): void {
    const s = this.section('Raw API Request');
    const form = document.createElement('div');
    form.className = 'acct-form';

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

    const paramsInput = document.createElement('textarea');
    paramsInput.placeholder = 'key=value (one per line)';
    paramsInput.rows = 4;
    paramsInput.style.cssText = 'width:100%;padding:8px;background:#0a0c10;border:1px solid #2a2d35;color:#e0e0e0;border-radius:6px;font-family:monospace;font-size:12px;resize:vertical;';
    form.appendChild(paramsInput);

    const sendBtn = this.button('Send Request', async () => {
      const params: Record<string, string> = {};
      for (const line of paramsInput.value.split('\n')) {
        const t = line.trim();
        if (t && t.includes('=')) { const [k, ...v] = t.split('='); params[k.trim()] = v.join('=').trim(); }
      }
      resultEl.textContent = 'Loading...';
      resultEl.style.color = '#888';
      try {
        const resp = await cloudApi.rawRequest(methodSel.value, pathInput.value.trim(), Object.keys(params).length ? params : undefined);
        resultEl.textContent = JSON.stringify(resp, null, 2);
        resultEl.style.color = resp.code === 100 ? '#a5d6a7' : '#ef9a9a';
      } catch (e) { resultEl.textContent = String(e); resultEl.style.color = '#ef5350'; }
    });
    form.appendChild(sendBtn);
    s.appendChild(form);
    this.content.appendChild(s);

    // Quick endpoints
    const endpoints: string[][] = [
      ['GET', 'user/info', ''], ['GET', 'device/bind/list', ''],
      ['GET', 'device/online/status', 'sn='], ['GET', 'device/location', 'sn='],
      ['GET', 'device/network', 'sn='], ['POST', 'v1/firmware/package/upgrade/list', 'sn='],
      ['POST', 'firmware/package/version', 'sn='], ['GET', 'app/version', 'platform=Android'],
      ['GET', 'tutorial/list', 'appName=Go2'], ['GET', 'v2/tutorial/list', 'appName=Go2'],
      ['GET', 'app/version/intro/list', 'lastId=0'], ['GET', 'app/notice/list', ''],
      ['GET', 'system/pubKey', ''], ['GET', 'flow/card/info', 'sn='],
      ['GET', 'device/flow/usage', 'sn=\nyear=2026\nmonth=4'], ['POST', 'device/wallet', 'sn='],
      ['POST', 'device/share/list', 'sn='], ['GET', 'advertisements', 'position=1'],
      ['GET', 'agreement/version/latest', ''], ['GET', 'exercise/data/summary', ''],
    ];
    const qs = this.section('Quick Endpoints');
    for (const [m, p, par] of endpoints) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0;cursor:pointer;border-bottom:1px solid #151820;';
      row.innerHTML = `<span style="font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;${m === 'GET' ? 'background:#1b5e20;color:#a5d6a7;' : 'background:#e65100;color:#ffcc80;'}">${m}</span><span style="font-size:12px;color:#4fc3f7;font-family:monospace;">${p}</span>`;
      row.addEventListener('click', () => { methodSel.value = m; pathInput.value = p; paramsInput.value = par; this.content.scrollTop = 0; });
      qs.appendChild(row);
    }
    this.content.appendChild(qs);

    const resultSection = this.section('Response');
    const resultEl = document.createElement('pre');
    resultEl.style.cssText = 'font-family:monospace;font-size:12px;color:#888;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;';
    resultEl.textContent = '(no request sent yet)';
    resultSection.appendChild(resultEl);
    this.content.appendChild(resultSection);
  }

  // ════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════

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

  destroy(): void { this.container.remove(); }
}

/**
 * Unitree Cloud API Client
 * Ported from unitree_account_manager/unitree_api.py
 * Uses browser-native fetch() + Vite proxy to bypass CORS/WAF
 */

import forge from 'node-forge';

const API_BASE = '/unitree-api';
const FIRMWARE_CDN = 'https://firmware-cdn.unitree.com';
const SIGN_SECRET = 'XyvkwK45hp5PHfA8';

function md5(s: string): string {
  return forge.md.md5.create().update(s).digest().toHex();
}

function buildHeaders(token = ''): Record<string, string> {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID?.()?.replace(/-/g, '') || md5(ts + Math.random());
  const sign = md5(`${SIGN_SECRET}${ts}${nonce}`);

  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'DeviceId': 'Samsung/Samsung/SM-S931B/s24/14/34',
    'AppTimezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'DevicePlatform': 'Android',
    'DeviceModel': 'SM-S931B',
    'SystemVersion': '34',
    'AppVersion': '1.11.4',
    'AppLocale': navigator.language?.replace('-', '_') || 'en_US',
    'AppTimestamp': ts,
    'AppNonce': nonce,
    'AppSign': sign,
    'Channel': 'UMENG_CHANNEL',
    'Token': token,
    'AppName': 'Go2',
  };
}

export interface UserInfo {
  uid: string;
  nickname: string;
  avatar: string;
  email: string;
  mobile: string;
  gender: number;
  roles: number[];
}

export interface RobotDevice {
  sn: string;
  alias: string;
  series: string;
  model: string;
  mac: string;
  connIp: string;
  connMode: string;
  online: boolean | null;
  remark: string;
  code: string;
  own: number;
  key: string;
}

export interface FirmwareInfo {
  firmwareId: string;
  packageName: string;
  version: string;
  ownVersion: string;
  description: string;
  download: string;
  md5: string;
}

export interface AppVersionInfo {
  VersionName: string;
  VersionCode: number;
  ApkSize: string;
  ApkMd5: string;
  DownloadUrl: string;
  ModifyContent: string;
}

export interface TutorialGroup {
  name: string;
  tutorials: Array<{
    id: string;
    title: string;
    cover: string;
    url: string;
    duration: number;
    description: string;
  }>;
}

export interface ChangelogEntry {
  id: string;
  title: string;
  link: string;
  publishTime: string;
}

interface ApiResponse<T = unknown> {
  code: number;
  data?: T;
  errorMsg?: string;
}

class UnitreeCloudError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export class UnitreeCloudAPI {
  private token = '';
  private refreshToken = '';
  user: UserInfo | null = null;

  get isLoggedIn(): boolean {
    return !!this.token;
  }

  get accessToken(): string {
    return this.token;
  }

  setAccessToken(token: string): void {
    this.token = token;
  }

  // ─── Session persistence ─────────────────────────────────────────

  saveSession(): void {
    try {
      localStorage.setItem('unitree_session', JSON.stringify({
        token: this.token,
        refreshToken: this.refreshToken,
        user: this.user,
      }));
    } catch { /* ignore */ }
  }

  loadSession(): boolean {
    try {
      const raw = localStorage.getItem('unitree_session');
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.token = data.token || '';
      this.refreshToken = data.refreshToken || '';
      this.user = data.user || null;
      return !!this.token;
    } catch {
      return false;
    }
  }

  clearSession(): void {
    this.token = '';
    this.refreshToken = '';
    this.user = null;
    localStorage.removeItem('unitree_session');
  }

  // ─── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(method: string, path: string, params?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = method === 'GET' && params
      ? `${API_BASE}/${path}?${new URLSearchParams(params)}`
      : `${API_BASE}/${path}`;

    const resp = await fetch(url, {
      method,
      headers: buildHeaders(this.token),
      body: method === 'POST' && params ? new URLSearchParams(params) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json: ApiResponse<T> = await resp.json();

    // Auto-refresh on token expiry
    if (json.code === 1001 && this.refreshToken) {
      const refreshed = await this.doRefreshToken();
      if (refreshed) return this.request(method, path, params);
    }

    return json;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const resp = await this.request<T>('GET', path, params);
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || `Error ${resp.code}`);
    return resp.data as T;
  }

  async post<T>(path: string, params?: Record<string, string>): Promise<T> {
    const resp = await this.request<T>('POST', path, params);
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || `Error ${resp.code}`);
    return resp.data as T;
  }

  private async doRefreshToken(): Promise<boolean> {
    try {
      const resp = await this.request<{ accessToken: string; refreshToken: string }>('POST', 'token/refresh', {
        refreshToken: this.refreshToken,
      });
      if (resp.code === 100 && resp.data) {
        this.token = resp.data.accessToken;
        this.refreshToken = resp.data.refreshToken || this.refreshToken;
        this.saveSession();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  // ─── Auth ────────────────────────────────────────────────────────

  async loginEmail(email: string, password: string): Promise<UserInfo> {
    const resp = await this.request<{ accessToken: string; refreshToken: string; user: UserInfo }>('POST', 'login/email', {
      email,
      password: md5(password),
    });
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || 'Login failed');
    this.token = resp.data!.accessToken;
    this.refreshToken = resp.data!.refreshToken || '';
    this.user = resp.data!.user || null;
    this.saveSession();
    return this.user!;
  }

  async sendEmailCaptcha(email: string): Promise<void> {
    await this.post('captcha/email', { email });
  }

  async registerEmail(email: string, password: string, captcha: string): Promise<void> {
    const resp = await this.request<{ accessToken: string; refreshToken: string; user: UserInfo }>('POST', 'register/email', {
      email, password: md5(password), captcha, region: 'US',
    });
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || 'Registration failed');
    this.token = resp.data!.accessToken;
    this.refreshToken = resp.data!.refreshToken || '';
    this.user = resp.data!.user || null;
    this.saveSession();
  }

  async resetPassword(email: string, captcha: string, newPassword: string): Promise<void> {
    await this.post('oauth/email/password/reset', { email, captcha, password: md5(newPassword) });
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.post('user/password/update', { oldPassword: md5(oldPassword), password: md5(newPassword) });
  }

  logout(): void {
    this.clearSession();
  }

  // ─── User ────────────────────────────────────────────────────────

  async getUserInfo(): Promise<UserInfo> {
    this.user = await this.get<UserInfo>('user/info');
    this.saveSession();
    return this.user;
  }

  async updateUserInfo(fields: { nickname?: string; avatar?: string }): Promise<void> {
    await this.post('user/info/update', fields as Record<string, string>);
  }

  // ─── Devices ─────────────────────────────────────────────────────

  async listDevices(): Promise<RobotDevice[]> {
    return (await this.get<RobotDevice[]>('device/bind/list')) || [];
  }

  async bindDevice(sn: string, alias = ''): Promise<void> {
    await this.post('device/bind', { sn, alias, mac: '', remark: '' });
  }

  async unbindDevice(sn: string): Promise<void> {
    await this.post('device/unbind', { sn });
  }

  async getDeviceOnlineStatus(sn: string): Promise<boolean> {
    return !!(await this.get<boolean>('device/online/status', { sn }));
  }

  async updateDevice(sn: string, alias: string, remark = ''): Promise<void> {
    await this.post('device/update', { sn, alias, remark });
  }

  async getDeviceNetwork(sn: string): Promise<string> {
    return (await this.get<string>('device/network', { sn })) || '';
  }

  async getDeviceLocation(sn: string): Promise<{ gpsEnable: number; latitude: string; longitude: string; gpsTimestamp: string }> {
    return await this.get('device/location', { sn });
  }

  async updateDeviceGps(sn: string, enable: boolean): Promise<void> {
    await this.post('device/location/updateStatus', { sn, gpsEnable: enable ? '1' : '0' });
  }

  // ─── Sharing ─────────────────────────────────────────────────────

  async shareDevice(sn: string, account: string): Promise<void> {
    await this.post('device/share/add', { sn, account, remark: '' });
  }

  async listShares(sn: string): Promise<Array<{ uid: string; nickname: string; shareUid: string }>> {
    return (await this.post('device/share/list', { sn })) || [];
  }

  async deleteShare(sn: string, shareUid: string): Promise<void> {
    await this.post('device/share/del', { sn, shareUid });
  }

  // ─── Firmware ────────────────────────────────────────────────────

  async listFirmwareUpdates(sn: string): Promise<FirmwareInfo[]> {
    return (await this.post<FirmwareInfo[]>('v1/firmware/package/upgrade/list', { sn })) || [];
  }

  async getFirmwareVersion(sn: string): Promise<string> {
    return (await this.post<string>('firmware/package/version', { sn })) || '';
  }

  getFirmwareDownloadUrl(downloadPath: string): string {
    return downloadPath.startsWith('http') ? downloadPath : `${FIRMWARE_CDN}${downloadPath}`;
  }

  // ─── App info ────────────────────────────────────────────────────

  async getAppVersion(): Promise<AppVersionInfo | null> {
    try {
      const raw = await this.get<string>('app/version', { platform: 'Android' });
      if (typeof raw === 'string') return JSON.parse(raw);
      return raw as unknown as AppVersionInfo;
    } catch { return null; }
  }

  async getTutorials(): Promise<TutorialGroup[]> {
    // Try v2 (grouped), fall back to v1 (flat)
    try {
      const resp = await this.request<{ groupList?: Array<{ name: string; tutorialList: unknown[] }> }>('GET', 'v2/tutorial/list', { appName: 'Go2' });
      if (resp.code === 100 && resp.data?.groupList) {
        return resp.data.groupList.map(g => ({
          name: g.name,
          tutorials: g.tutorialList as TutorialGroup['tutorials'],
        }));
      }
    } catch { /* fall through */ }

    try {
      const flat = await this.get<TutorialGroup['tutorials']>('tutorial/list', { appName: 'Go2' });
      if (Array.isArray(flat) && flat.length) return [{ name: 'Tutorials', tutorials: flat }];
    } catch { /* ignore */ }
    return [];
  }

  async getChangelog(): Promise<ChangelogEntry[]> {
    try {
      const resp = await this.get<{ items: ChangelogEntry[] }>('app/version/intro/list', { lastId: '0' });
      return resp?.items || [];
    } catch { return []; }
  }

  async getNotices(): Promise<Array<{ title: string; content: string; createTime: string }>> {
    try { return (await this.get('app/notice/list')) || []; } catch { return []; }
  }

  // ─── Wallet / Flow ───────────────────────────────────────────────

  async getDeviceWallet(sn: string): Promise<unknown> {
    return await this.post('device/wallet', { sn });
  }

  async getDataUsage(sn: string, year: number, month: number): Promise<unknown> {
    return await this.get('device/flow/usage', { sn, year: String(year), month: String(month) });
  }

  // ─── Debug / Raw ─────────────────────────────────────────────────

  async rawRequest(method: string, path: string, params?: Record<string, string>): Promise<ApiResponse> {
    return await this.request(method, path, params);
  }
}

// Singleton
export const cloudApi = new UnitreeCloudAPI();

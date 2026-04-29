/**
 * Unitree Cloud API Client
 * Ported from unitree_account_manager/unitree_api.py
 * Uses browser-native fetch() + Vite proxy to bypass CORS/WAF
 */

import forge from 'node-forge';

const API_BASE = '/unitree-api';
const FIRMWARE_CDN = 'https://firmware-cdn.unitree.com';
const SIGN_SECRET = 'XyvkwK45hp5PHfA8';

// Robot families this UI is tested against. The Unitree cloud server keys
// some responses (tutorials, firmware lists, announcements) off the AppName
// header — Go2 has its own dedicated mobile app (AppName='Go2'); G1 ships
// in the Unitree Explorer app which identifies as 'B2' internally
// (RetrofitFactory.java:139 in the decompiled APK). Other Explorer-line
// models (R1 / B2 / H1) presumably share AppName='B2' but aren't on hand
// to verify, so the choice is intentionally limited to Go2 + G1.
export type RobotFamily = 'Go2' | 'G1';
export const ROBOT_FAMILIES: ReadonlyArray<RobotFamily> = ['Go2', 'G1'];
const APP_NAME: Record<RobotFamily, string> = {
  Go2: 'Go2',
  G1:  'B2',
};
/** Human-readable label for the family pill. */
export const FAMILY_LABEL: Record<RobotFamily, string> = {
  Go2: 'Go2',
  G1:  'G1',
};

// Region selects which Unitree cloud endpoint the Vite proxy forwards to.
// Sent as the `X-Unitree-Region` header; the proxy maps it to a hostname and
// strips the header before forwarding upstream.
export type Region = 'global' | 'cn';
export const REGIONS: ReadonlyArray<Region> = ['global', 'cn'];

// Unitree shipped response-body encryption in recent app versions (v1.12+).
// Some endpoints (tutorial/list, app/version, app/version/intro/list) now
// return raw AES-128-CFB128 ciphertext instead of JSON. The key/IV were
// extracted from com/unitree/baselibrary/util/AESUtil.smali — same pair
// also used by the BLE protocol.
const CLOUD_AES_KEY = 'df98b715d5c6ed2b25817b6f2554124a';
const CLOUD_AES_IV  = '2841ae97419c2973296a0d4bdfe19a4f';

function md5(s: string): string {
  return forge.md.md5.create().update(s).digest().toHex();
}

/** AES-128-CFB (128-bit segment) decrypt. Returns raw-byte-string + UTF-8 decoded
 *  string if valid. Never throws — callers check .utf8 to tell success. */
function decryptCloudBody(cipherBytes: Uint8Array): { raw: string; utf8: string | null } {
  const keyBytes = forge.util.hexToBytes(CLOUD_AES_KEY);
  const ivBytes = forge.util.hexToBytes(CLOUD_AES_IV);
  const decipher = forge.cipher.createDecipher('AES-CFB', keyBytes);
  decipher.start({ iv: ivBytes });
  let bin = '';
  for (let i = 0; i < cipherBytes.length; i++) bin += String.fromCharCode(cipherBytes[i]);
  decipher.update(forge.util.createBuffer(bin, 'raw'));
  decipher.finish();
  const raw = decipher.output.getBytes();
  try {
    return { raw, utf8: forge.util.decodeUtf8(raw) };
  } catch {
    return { raw, utf8: null };
  }
}

/** Parse a JWT payload (no signature check) — used for local `exp` inspection. */
function decodeJwtPayload(tok: string): Record<string, unknown> | null {
  try {
    const p = tok.split('.')[1];
    if (!p) return null;
    let s = p.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(atob(s));
  } catch { return null; }
}

/** Hex preview of the first `max` bytes — used for diagnostic logging. */
function bytesToHex(s: string, max = 48): string {
  let out = '';
  const n = Math.min(s.length, max);
  for (let i = 0; i < n; i++) out += s.charCodeAt(i).toString(16).padStart(2, '0') + ' ';
  if (s.length > max) out += '…';
  return out.trim();
}

/** Globally exposed meta for the most recent request (read by the Debug tab). */
export interface LastResponseMeta {
  path: string;
  bodyBytes: number;
  contentType: string;
  /** Content-Encoding header from the server (gzip / deflate / br / 'none') —
   *  fetch auto-decompresses, so bodyBytes is the *decompressed* size. */
  compression: string;
  decryption: 'none' | 'body-cfb' | 'failed';
  rawPreview: string;
  decryptedPreview: string;
}
let _lastResponseMeta: LastResponseMeta = {
  path: '', bodyBytes: 0, contentType: '', compression: 'none', decryption: 'none',
  rawPreview: '', decryptedPreview: '',
};
export function getLastResponseMeta(): LastResponseMeta { return { ..._lastResponseMeta }; }

/** Platform identity we impersonate. Most endpoints just want a valid header set;
 *  a few (notably GET /app/version) key their response off this. */
export type Platform = 'Android' | 'iOS';

function buildHeaders(
  token = '',
  platform: Platform = 'Android',
  family: RobotFamily = 'Go2',
  region: Region = 'global',
): Record<string, string> {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID?.()?.replace(/-/g, '') || md5(ts + Math.random());
  const sign = md5(`${SIGN_SECRET}${ts}${nonce}`);

  const common = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'AppTimezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'AppVersion': '1.12.4',
    'AppLocale': navigator.language?.replace('-', '_') || 'en_US',
    'AppTimestamp': ts,
    'AppNonce': nonce,
    'AppSign': sign,
    'Channel': 'release',
    'Token': token,
    'AppName': APP_NAME[family],
    'X-Unitree-Region': region,
  };

  // DeviceId fields are pipe-joined to match the Unitree Explorer / Go2 apps —
  // the upstream API doesn't validate the value but matching the format keeps
  // server-side analytics clean.
  if (platform === 'iOS') {
    return {
      ...common,
      'DeviceId': 'Apple|iPhone|iPhone15,3|iPhone15,3|17.6.1|34',
      'DevicePlatform': 'iOS',
      'DeviceModel': 'iPhone15,3',
      'SystemVersion': '17.6.1',
    };
  }

  return {
    ...common,
    'DeviceId': 'Samsung|Samsung|SM-S931B|s24|14|34',
    'DevicePlatform': 'Android',
    'DeviceModel': 'SM-S931B',
    'SystemVersion': '34',
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

function readLocalEnum<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (v && (allowed as ReadonlyArray<string>).includes(v)) ? (v as T) : fallback;
  } catch { return fallback; }
}

function readPersistedFamily(): RobotFamily {
  try {
    const v = localStorage.getItem('unitree_family');
    if (v === 'Go2' || v === 'G1') return v;
    // Migrate legacy values written before the family list was simplified
    // (anything other than Go2 maps onto the Explorer-line, now keyed as G1).
    if (v === 'Explorer' || v === 'B2' || v === 'R1' || v === 'H1' || v === 'H2') {
      localStorage.setItem('unitree_family', 'G1');
      return 'G1';
    }
  } catch { /* ignore */ }
  return 'Go2';
}

export class UnitreeCloudAPI {
  private token = '';
  private refreshToken = '';
  private _lastRefreshedAt: number | null = null;
  user: UserInfo | null = null;

  // Persisted in localStorage; surfaced via the connection-panel family switch.
  private _family: RobotFamily = readPersistedFamily();
  private _region: Region = readLocalEnum<Region>('unitree_region', REGIONS, 'global');

  get family(): RobotFamily { return this._family; }
  setFamily(f: RobotFamily): void {
    this._family = f;
    try { localStorage.setItem('unitree_family', f); } catch { /* ignore */ }
  }

  get region(): Region { return this._region; }
  setRegion(r: Region): void {
    this._region = r;
    try { localStorage.setItem('unitree_region', r); } catch { /* ignore */ }
  }

  get isLoggedIn(): boolean {
    return !!this.token;
  }

  get accessToken(): string {
    return this.token;
  }

  /** Unix seconds when the access token was last minted (login or refresh). */
  get lastRefreshedAt(): number | null {
    return this._lastRefreshedAt;
  }

  setAccessToken(token: string): void {
    this.token = token;
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
  }

  // ─── Session persistence ─────────────────────────────────────────

  saveSession(): void {
    try {
      localStorage.setItem('unitree_session', JSON.stringify({
        token: this.token,
        refreshToken: this.refreshToken,
        user: this.user,
        lastRefreshedAt: this._lastRefreshedAt,
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
      this._lastRefreshedAt = typeof data.lastRefreshedAt === 'number' ? data.lastRefreshedAt : null;
      return !!this.token;
    } catch {
      return false;
    }
  }

  clearSession(): void {
    this.token = '';
    this.refreshToken = '';
    this.user = null;
    this._lastRefreshedAt = null;
    localStorage.removeItem('unitree_session');
  }

  /** Proactively refresh the access token if it's near/past expiry.
   *  Returns false (and clears the session) if the token can't be renewed. */
  async ensureFreshToken(bufferSeconds = 600): Promise<boolean> {
    if (!this.token) return false;
    const payload = decodeJwtPayload(this.token);
    const exp = payload && typeof payload.exp === 'number' ? (payload.exp as number) : null;
    if (exp === null) return true; // unknown exp — rely on 1001 handling mid-flight
    const now = Math.floor(Date.now() / 1000);
    if (exp - now > bufferSeconds) return true;
    if (!this.refreshToken) { this.clearSession(); return false; }
    const ok = await this.doRefreshToken();
    if (!ok) this.clearSession();
    return ok;
  }

  // ─── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(method: string, path: string, params?: Record<string, string>, platform: Platform = 'Android'): Promise<ApiResponse<T>> {
    const url = method === 'GET' && params
      ? `${API_BASE}/${path}?${new URLSearchParams(params)}`
      : `${API_BASE}/${path}`;

    console.groupCollapsed(`[cloud-api] ${method} ${path}`);
    if (params) console.log('params:', params);

    const resp = await fetch(url, {
      method,
      headers: buildHeaders(this.token, platform, this._family, this._region),
      body: method === 'POST' && params ? new URLSearchParams(params) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) { console.groupEnd(); throw new Error(`HTTP ${resp.status}`); }

    // Upstream returns either plain JSON (most endpoints) or raw AES-128-CFB
    // ciphertext (e.g. the /announcement endpoint since app v1.12). Compressed
    // responses (gzip/deflate/br) are auto-decompressed by fetch because the
    // Vite proxy forwards Content-Encoding; we still capture the original
    // encoding into the meta for display.
    const contentType = resp.headers.get('content-type') || '';
    const contentEncoding = resp.headers.get('content-encoding') || 'none';

    const raw = await resp.arrayBuffer();
    const rawBytes = new Uint8Array(raw);
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    const hexPreview = bytesToHex(String.fromCharCode(...rawBytes.slice(0, 32)), 32);

    _lastResponseMeta = {
      path, bodyBytes: rawBytes.length,
      contentType, compression: contentEncoding,
      decryption: 'none',
      rawPreview: hexPreview,
      decryptedPreview: '',
    };

    let json: ApiResponse<T> | null = null;
    try {
      json = JSON.parse(asText);
    } catch {
      // Body wasn't plain JSON — try AES-CFB decrypt with the hardcoded key/IV
      const r = decryptCloudBody(rawBytes);
      if (r.utf8) {
        try {
          json = JSON.parse(r.utf8);
          _lastResponseMeta.decryption = 'body-cfb';
          _lastResponseMeta.decryptedPreview = r.utf8.slice(0, 400);
          console.log(`[cloud-api] ${path}: AES-CFB decrypted (${rawBytes.length} bytes ciphertext)`);
        } catch { /* fall through to failure */ }
      }
      if (!json) {
        const decHex = bytesToHex(r.raw, 32);
        _lastResponseMeta.decryption = 'failed';
        _lastResponseMeta.decryptedPreview = `(non-UTF-8) hex: ${decHex}`;
        console.warn(`[cloud-api] ${path}: decode failed. raw: ${hexPreview} · aes-cfb: ${decHex}`);
        console.groupEnd();
        throw new Error(`Response decode failed (plain + AES-CFB). Body hex: ${hexPreview}`);
      }
    }

    const result = json as ApiResponse<T>;
    console.groupEnd();

    // Auto-refresh on token expiry
    if (result.code === 1001 && this.refreshToken) {
      const refreshed = await this.doRefreshToken();
      if (refreshed) return this.request(method, path, params, platform);
    }

    return result;
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
        this._lastRefreshedAt = Math.floor(Date.now() / 1000);
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
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
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
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
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

  /** Cloud-side RSA public key used to wrap the SN for `device/bindExtData`. */
  async getPubKey(): Promise<string> {
    return (await this.get<string>('system/pubKey')) || '';
  }

  /**
   * POST `device/bindExtData` exactly as the 1.9.3 apk does:
   *   extData=<44-char base64 BLE GCM key>
   *   sn=<base64(RSA(SN))>     ← same RSA-encrypted-SN convention as
   *                              `device/bind` and `device/unbind`
   * Response `data` is the 16-byte AES-128 key as a hex string.
   */
  async bindExtData(extData: string, snEncrypted: string): Promise<string> {
    return (await this.post<string>('device/bindExtData', {
      extData,
      sn: snEncrypted,
    })) || '';
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
    if (downloadPath.startsWith('http')) return downloadPath;
    // The API returns `download` as an unencoded path (e.g. ".../package_..._G1_Edu+_...upk")
    // while the parallel `packageName` field is URL-encoded ("..._G1_Edu%2B_..."). The CDN
    // routes on the encoded form — fetching the raw `+` returns 404 because `+` decodes to
    // a space in URL parsers. Percent-encode each path segment (preserving the slashes).
    const encoded = downloadPath.split('/').map(s => encodeURIComponent(s)).join('/');
    return `${FIRMWARE_CDN}${encoded}`;
  }

  // ─── App info ────────────────────────────────────────────────────

  async getAppVersion(platform: Platform = 'Android'): Promise<AppVersionInfo | null> {
    try {
      // Send matching DevicePlatform header + query param so the server returns
      // the version info for the requested store (APK vs App Store).
      const resp = await this.request<string>('GET', 'app/version', { platform }, platform);
      if (resp.code !== 100) return null;
      const raw = resp.data;
      if (typeof raw === 'string') return JSON.parse(raw);
      return raw as unknown as AppVersionInfo;
    } catch { return null; }
  }

  async getTutorials(): Promise<TutorialGroup[]> {
    const appName = APP_NAME[this._family];
    // Try v2 (grouped), fall back to v1 (flat)
    try {
      const resp = await this.request<{ groupList?: Array<{ name: string; tutorialList: unknown[] }> }>('GET', 'v2/tutorial/list', { appName });
      if (resp.code === 100 && resp.data?.groupList) {
        return resp.data.groupList.map(g => ({
          name: g.name,
          tutorials: g.tutorialList as TutorialGroup['tutorials'],
        }));
      }
    } catch { /* fall through */ }

    try {
      const flat = await this.get<TutorialGroup['tutorials']>('tutorial/list', { appName });
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

  async rawRequest(method: string, path: string, params?: Record<string, string>, platform: Platform = 'Android'): Promise<ApiResponse> {
    return await this.request(method, path, params, platform);
  }
}

// Singleton
export const cloudApi = new UnitreeCloudAPI();

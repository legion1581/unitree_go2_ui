import type { ConnectionCallbacks, SdpPayload, TurnServerInfo } from '../types';
import { aesEncrypt, aesDecrypt, generateAesKey } from '../crypto/aes';
import { loadPublicKey, rsaEncrypt } from '../crypto/rsa';
import { cloudApi } from '../api/unitree-cloud';
// Proxy through Vite dev server to avoid CORS issues with Unitree cloud API
const REMOTE_API_BASE = '/unitree-api';
import { WebRTCConnection } from './webrtc';
import forge from 'node-forge';

function buildHeaders(token: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID?.()?.replace(/-/g, '') || forge.md.md5.create().update(timestamp).digest().toHex();
  const signSecret = 'XyvkwK45hp5PHfA8';
  const appSign = forge.md.md5.create().update(`${signSecret}${timestamp}${nonce}`).digest().toHex();

  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'DeviceId': 'Samsung/Samsung/SM-S931B/s24/14/34',
    'AppTimezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'DevicePlatform': 'Android',
    'DeviceModel': 'SM-S931B',
    'SystemVersion': '34',
    'AppVersion': '1.11.4',
    'AppLocale': navigator.language?.replace('-', '_') || 'en_US',
    'AppTimestamp': timestamp,
    'AppNonce': nonce,
    'AppSign': appSign,
    'Channel': 'UMENG_CHANNEL',
    'Token': token,
    'AppName': 'Go2',
  };
}

async function fetchAppPublicKey(token: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${REMOTE_API_BASE}/system/pubKey`, {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Unitree cloud API timed out — check your internet connection');
    }
    throw new Error('Cannot reach Unitree cloud API — check your internet connection');
  }
  if (!resp.ok) throw new Error(`Unitree API returned HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.code !== 100) throw new Error(`Failed to fetch encryption key (code ${json.code})`);
  return json.data;
}

/**
 * Login via cloud API. Uses the shared cloudApi singleton so the Account
 * Manager page can see the session.  Returns the access token.
 */
export async function loginWithEmail(email: string, password: string): Promise<string> {
  await cloudApi.loginEmail(email, password);
  return cloudApi.accessToken;
}

async function fetchTurnServerInfo(
  sn: string,
  token: string,
  publicKey: forge.pki.rsa.PublicKey,
): Promise<TurnServerInfo> {
  const aesKey = generateAesKey();
  const encryptedKey = rsaEncrypt(aesKey, publicKey);

  const body = new URLSearchParams({ sn, sk: encryptedKey });
  let resp: Response;
  try {
    resp = await fetch(`${REMOTE_API_BASE}/webrtc/account`, {
      method: 'POST',
      headers: buildHeaders(token),
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('TURN server request timed out');
    }
    throw new Error('Cannot reach Unitree WebRTC service');
  }
  if (!resp.ok) throw new Error(`WebRTC service returned HTTP ${resp.status}`);
  let json: { code: number; data?: string; errorMsg?: string };
  try {
    json = await resp.json();
  } catch {
    throw new Error('Invalid response from WebRTC service (not JSON)');
  }
  if (json.code === 13003) throw new Error('Request rejected by server — try again');
  if (json.code !== 100) throw new Error(`TURN server error: ${json.errorMsg || `code ${json.code}`}`);
  if (!json.data) throw new Error('TURN server returned empty data');

  const decrypted = await aesDecrypt(json.data, aesKey);
  return JSON.parse(decrypted);
}

async function exchangeSdpRemote(
  sn: string,
  sdpPayload: SdpPayload,
  token: string,
  publicKey: forge.pki.rsa.PublicKey,
): Promise<string> {
  const aesKey = generateAesKey();
  const encryptedKey = rsaEncrypt(aesKey, publicKey);
  const encryptedSdp = await aesEncrypt(JSON.stringify(sdpPayload), aesKey);

  const body = new URLSearchParams({
    sn,
    sk: encryptedKey,
    data: encryptedSdp,
    timeout: '5',
  });

  let resp: Response;
  try {
    resp = await fetch(`${REMOTE_API_BASE}/webrtc/connect`, {
      method: 'POST',
      headers: buildHeaders(token),
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Robot did not respond — it may be offline or unreachable');
    }
    throw new Error('Cannot reach Unitree WebRTC service');
  }
  if (!resp.ok) throw new Error(`WebRTC connect returned HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.code === 1000) throw new Error('Robot is offline — power it on and try again');
  if (json.code !== 100) throw new Error(`SDP exchange failed: ${json.errorMsg || `code ${json.code}`}`);
  if (!json.data) throw new Error('Robot returned empty SDP answer');

  const decrypted = await aesDecrypt(json.data, aesKey);
  const answer = JSON.parse(decrypted);

  if (answer.sdp === 'reject') {
    throw new Error('Device rejected connection — another client may be connected');
  }

  return answer.sdp;
}

export async function connectRemote(
  sn: string,
  token: string,
  callbacks: ConnectionCallbacks,
  onStep?: (msg: string) => void,
): Promise<WebRTCConnection> {
  onStep?.('Fetching encryption key...');
  const pubKeyB64 = await fetchAppPublicKey(token);
  const publicKey = loadPublicKey(pubKeyB64);

  onStep?.('Requesting TURN server...');
  const turnInfo = await fetchTurnServerInfo(sn, token, publicKey);

  onStep?.('Creating WebRTC offer...');
  const webrtc = new WebRTCConnection(callbacks, turnInfo);

  const sdpString = await webrtc.createOffer();
  const sdpPayload: SdpPayload = {
    id: '',
    sdp: sdpString,
    type: 'offer',
    token,
    turnserver: turnInfo,
  };

  onStep?.('Sending offer to robot...');
  const answerSdp = await exchangeSdpRemote(sn, sdpPayload, token, publicKey);

  onStep?.('Setting remote description...');
  await webrtc.setAnswer(answerSdp);
  return webrtc;
}

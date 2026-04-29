import type { ConNotifyResponse, ConnectionCallbacks, SdpPayload } from '../types';
import { aesEncrypt, aesDecrypt, aesGcmDecrypt, generateAesKey, hexToBytes } from '../crypto/aes';
import { loadPublicKey, rsaEncrypt } from '../crypto/rsa';
import { LOCAL_PORT, LOCAL_OFFER_PORT } from './modes';
import { WebRTCConnection } from './webrtc';
import { cloudApi } from '../api/unitree-cloud';
import { getCachedAesKey, setCachedAesKey } from '../api/aes-key-derive';

// Log prefix follows the active family at call time so a Go2 vs G1
// connection attempt is distinguishable in DevTools.
const tag = (): string => `[${cloudApi.family.toLowerCase()}]`;

export type AesKeyPrompter = (sn: string) => Promise<string>;

function proxyUrl(path: string): string {
  return `/robot-api${path}`;
}

function proxyHeaders(host: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Robot-Host': host };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function extractPathEnding(data1: string): string {
  const tail = data1.slice(-10);
  const lookup = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  let path = '';
  for (let i = 0; i < tail.length; i += 2) {
    const ch = tail[i + 1];
    const idx = lookup.indexOf(ch);
    path += idx >= 0 ? idx.toString() : '0';
  }
  return path;
}

async function decryptData1(
  resp: ConNotifyResponse,
  sn: string,
  promptKey?: AesKeyPrompter,
): Promise<string> {
  if (resp.data2 === 2) {
    return await aesGcmDecrypt(resp.data1);
  }
  if (resp.data2 === 3) {
    // Per-device AES-128 key required (G1 ≥ 1.5.1). Pull from cache; if the
    // user hasn't derived one yet, ask via `promptKey` and cache the result.
    let aesHex = sn ? getCachedAesKey(sn) : null;
    if (!aesHex) {
      if (!promptKey) {
        throw new Error('data2=3 needs an AES-128 key. Open Account → device tile → "AES Key" to derive one for this SN.');
      }
      aesHex = (await promptKey(sn)).trim();
      if (!aesHex) throw new Error('AES-128 key required to decrypt con_notify');
      if (sn) setCachedAesKey(sn, aesHex);
    }
    console.log(`${tag()} Using cached AES-128 key for SN ${sn || '<unknown>'}`);
    return await aesGcmDecrypt(resp.data1, hexToBytes(aesHex));
  }
  return resp.data1;
}

async function detectPort(ip: string): Promise<'new' | 'old'> {
  // Try port 9991 first (newer firmware), then 8081 (older firmware)
  try {
    const resp = await fetch(proxyUrl('/con_notify'), {
      method: 'POST',
      headers: proxyHeaders(`${ip}:${LOCAL_PORT}`),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      console.log(`${tag()} Port ${LOCAL_PORT} available (new method)`);
      return 'new';
    }
  } catch { /* port not available */ }

  try {
    const resp = await fetch(proxyUrl('/'), {
      method: 'HEAD',
      headers: proxyHeaders(`${ip}:${LOCAL_OFFER_PORT}`),
      signal: AbortSignal.timeout(3000),
    });
    // Even a 404 means the port is reachable
    if (resp.status !== 502) {
      console.log(`${tag()} Port ${LOCAL_OFFER_PORT} available (old method)`);
      return 'old';
    }
  } catch { /* port not available */ }

  throw new Error(`Robot not responding at ${ip} — verify IP and that the robot is powered on`);
}

export async function connectLocal(
  ip: string,
  mode: 'AP' | 'STA-L',
  callbacks: ConnectionCallbacks,
  onStep?: (msg: string) => void,
  opts: { sn?: string; promptKey?: AesKeyPrompter } = {},
): Promise<WebRTCConnection> {
  console.log(`${tag()} Connecting to ${ip} in ${mode} mode...`);

  onStep?.(`Detecting robot at ${ip}...`);
  const method = await detectPort(ip);
  console.log(`${tag()} Using ${method} method`);

  onStep?.('Creating WebRTC offer...');
  const webrtc = new WebRTCConnection(callbacks);
  const sdpString = await webrtc.createOffer();
  console.log(`${tag()} Created WebRTC offer (${sdpString.length} bytes)`);

  const id = mode === 'AP' ? 'abcd' : 'STA_localNetwork';
  const sdpPayload: SdpPayload = {
    id,
    sdp: sdpString,
    type: 'offer',
    token: '',
  };

  try {
    let answerSdp: string;

    onStep?.('Exchanging SDP with robot...');
    if (method === 'new') {
      answerSdp = await exchangeSdpNew(ip, sdpPayload, opts.sn ?? '', opts.promptKey);
    } else {
      answerSdp = await exchangeSdpOld(ip, sdpPayload);
    }

    if (answerSdp === 'reject') {
      webrtc.close();
      throw new Error('Device rejected connection — another client may be connected');
    }

    console.log(`${tag()} Received answer SDP (${answerSdp.length} bytes)`);
    console.log(`${tag()} Answer SDP starts with: ${answerSdp.slice(0, 80)}...`);

    onStep?.('Setting remote description...');
    await webrtc.setAnswer(answerSdp);
    console.log(`${tag()} Remote description set, waiting for connection...`);

    return webrtc;
  } catch (err) {
    webrtc.close();
    throw err;
  }
}

async function exchangeSdpNew(
  ip: string,
  payload: SdpPayload,
  sn: string,
  promptKey?: AesKeyPrompter,
): Promise<string> {
  const host = `${ip}:${LOCAL_PORT}`;

  // Step 1: con_notify — get public key
  console.log(`${tag()} Sending con_notify to ${host}...`);
  const notifyResp = await fetch(proxyUrl('/con_notify'), {
    method: 'POST',
    headers: proxyHeaders(host),
  });

  if (!notifyResp.ok) {
    throw new Error(`con_notify failed: HTTP ${notifyResp.status}`);
  }

  const notifyB64 = await notifyResp.text();
  const notifyJson: ConNotifyResponse = JSON.parse(atob(notifyB64));
  console.log(`${tag()} con_notify response: data2=${notifyJson.data2}, data1 length=${notifyJson.data1.length}`);

  const data1 = await decryptData1(notifyJson, sn, promptKey);
  console.log(`${tag()} Decrypted data1 length: ${data1.length}`);

  // Extract public key (strip 10-char padding each end)
  const pubKeyB64 = data1.slice(10, data1.length - 10);
  const publicKey = loadPublicKey(pubKeyB64);

  // Compute path ending from decrypted data1
  const pathEnding = extractPathEnding(data1);
  console.log(`${tag()} Path ending: ${pathEnding}`);

  // Step 2: con_ing — encrypted SDP exchange
  const aesKey = generateAesKey();
  console.log(`${tag()} AES key: ${aesKey}`);

  const encryptedSdp = await aesEncrypt(JSON.stringify(payload), aesKey);
  const encryptedKey = rsaEncrypt(aesKey, publicKey);

  const body = JSON.stringify({
    data1: encryptedSdp,
    data2: encryptedKey,
  });

  console.log(`${tag()} Sending con_ing_${pathEnding} (body: ${body.length} bytes)...`);
  const ingResp = await fetch(proxyUrl(`/con_ing_${pathEnding}`), {
    method: 'POST',
    headers: proxyHeaders(host, 'application/x-www-form-urlencoded'),
    body,
  });

  if (!ingResp.ok) {
    const errText = await ingResp.text();
    throw new Error(`con_ing failed: HTTP ${ingResp.status} — ${errText}`);
  }

  const encryptedAnswer = await ingResp.text();
  console.log(`${tag()} con_ing response length: ${encryptedAnswer.length}`);

  const decryptedAnswer = await aesDecrypt(encryptedAnswer, aesKey);
  console.log(`${tag()} Decrypted answer: ${decryptedAnswer.slice(0, 100)}...`);

  const answerJson = JSON.parse(decryptedAnswer);
  return answerJson.sdp;
}

async function exchangeSdpOld(ip: string, payload: SdpPayload): Promise<string> {
  const host = `${ip}:${LOCAL_OFFER_PORT}`;

  console.log(`${tag()} Sending SDP to ${host}/offer...`);
  const resp = await fetch(proxyUrl('/offer'), {
    method: 'POST',
    headers: proxyHeaders(host, 'application/json'),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`offer failed: HTTP ${resp.status}`);
  }

  const answer = await resp.json();
  console.log(`${tag()} Received answer from old endpoint`);
  return answer.sdp;
}

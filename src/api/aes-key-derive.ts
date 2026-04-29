/**
 * Derive the 16-byte AES-128 key used for WebRTC `data2=3` SDP authentication.
 *
 * Wire-level flow (mirrors the `webrtc/account` pattern that the apk's
 * remote-connector already uses):
 *   1. Generate a random 16-byte AES key locally (32 hex chars, used as both
 *      the AES-CBC key passed to forge and the hex string sent to the server).
 *   2. RSA-encrypt that random key with the cloud's public RSA key (PKCS1
 *      v1.5; OAEP variants tried as fallbacks). The result is `sk`.
 *   3. POST `extData=<ble_gcm_key> & sn=<plain> & sk=<rsa-wrapped-key>` to
 *      `device/bindExtData`.
 *   4. The cloud returns AES-CBC-encrypted JSON. Decrypt with the random key
 *      and pull the 16-byte AES-128 key out of the resulting payload.
 *
 * The 1.9.3 apk's older single-field shape (`sn=RSA(SN)`) is rejected by
 * current servers with `"sk decode error"` — they universally expect `sk`
 * to be a wrapped session key.
 *
 * The result is cached per-SN in localStorage so a second connect to the same
 * robot doesn't need to re-prompt for the BLE key.
 */

import { cloudApi } from './unitree-cloud';
import { loadPublicKey, rsaEncrypt, type RsaPadding } from '../crypto/rsa';
import { aesDecrypt, generateAesKey } from '../crypto/aes';

const CACHE_KEY = 'unitree_aes_keys_v1';

type Cache = Record<string, string>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* full disk / private mode */ }
}

export function getCachedAesKey(sn: string): string | null {
  return readCache()[sn] || null;
}

export function setCachedAesKey(sn: string, key: string): void {
  const cache = readCache();
  cache[sn] = key;
  writeCache(cache);
}

export function clearCachedAesKey(sn: string): void {
  const cache = readCache();
  if (sn in cache) {
    delete cache[sn];
    writeCache(cache);
  }
}

/** Best-effort lookup of the 16-byte AES-128 key inside an arbitrary JSON
 * shape returned by the cloud. The apk's `Main3ViewModel.bindExtData` just
 * uses `baseResp.data` directly as a string, but `webrtc/account`-style
 * responses wrap the same value in `{ data: '<hex>' }` or
 * `{ key: '<hex>' }`. Accept both. */
function extractAesKey(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const k of ['key', 'data', 'aesKey', 'gcmKey', 'extData']) {
      const v = obj[k];
      if (typeof v === 'string' && /^[0-9a-fA-F]{32,64}$/.test(v.trim())) return v.trim();
    }
  }
  return null;
}

export async function deriveAesKey(sn: string, gcmKeyB64: string): Promise<string> {
  const sn0 = sn.trim();
  const gcm0 = gcmKeyB64.trim();
  if (!sn0) throw new Error('SN missing');
  if (!gcm0) throw new Error('GCM key missing');

  const pubKeyB64 = await cloudApi.getPubKey();
  if (!pubKeyB64) throw new Error('system/pubKey returned empty body');

  const pubKeyTrim = pubKeyB64.trim();
  console.log(`[bindExtData] pubKey length=${pubKeyTrim.length}, head='${pubKeyTrim.slice(0, 32)}...', tail='...${pubKeyTrim.slice(-20)}'`);

  let publicKey;
  try {
    publicKey = loadPublicKey(pubKeyTrim);
  } catch (e) {
    throw new Error(`pubKey parse failed: ${e instanceof Error ? e.message : String(e)} — first 32 chars: ${pubKeyTrim.slice(0, 32)}`);
  }
  const modulusBits = publicKey.n.bitLength();
  console.log(`[bindExtData] modulus=${modulusBits}-bit, sn='${sn0}' (${sn0.length} chars), extData length=${gcm0.length}`);

  // Random 16-byte AES key (32 hex chars). This is used both as `sk` (after
  // RSA wrapping) and as the AES-CBC key for decrypting the response body.
  const sessionAesKey = generateAesKey();

  const schemes: RsaPadding[] = ['PKCS1-V1_5', 'OAEP-SHA1', 'OAEP-SHA256'];
  let lastErr: unknown = null;
  for (const padding of schemes) {
    try {
      const skWrapped = rsaEncrypt(sessionAesKey, publicKey, padding);
      console.log(`[bindExtData] trying padding=${padding} sk length=${skWrapped.length}`);
      const respData = await cloudApi.bindExtData(gcm0, sn0, skWrapped);
      if (!respData) throw new Error('empty data in response');
      // Cloud responds with AES-CBC-encrypted JSON; decrypt with our session key.
      let decrypted: string;
      try {
        decrypted = await aesDecrypt(respData, sessionAesKey);
      } catch (e) {
        // Fallback: a few endpoints return the key plaintext if there's no
        // pairing with `sk`. Try treating respData itself as the key.
        if (/^[0-9a-fA-F]{32,64}$/.test(respData)) {
          console.log(`[bindExtData] padding=${padding} succeeded (plaintext response)`);
          setCachedAesKey(sn0, respData);
          return respData;
        }
        throw new Error(`AES-decrypt failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      let parsed: unknown = decrypted;
      try { parsed = JSON.parse(decrypted); } catch { /* not JSON, keep string */ }
      const aesKey = extractAesKey(parsed);
      if (!aesKey) throw new Error(`unexpected payload shape: ${decrypted.slice(0, 120)}`);
      console.log(`[bindExtData] padding=${padding} succeeded → key length=${aesKey.length}`);
      setCachedAesKey(sn0, aesKey);
      return aesKey;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bindExtData] padding=${padding} failed: ${msg}`);
      lastErr = e;
      // Only retry on cloud-side decode errors. Network / parsing errors
      // wouldn't change between padding schemes.
      if (!msg.toLowerCase().includes('decode') && !msg.toLowerCase().includes('error 500')) {
        throw e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('bindExtData rejected every RSA padding tried');
}

/**
 * Derive the 16-byte AES-128 key used for WebRTC `data2=3` SDP authentication
 * by trading the BLE-returned GCM key (44-char base64) + SN through the
 * `device/bindExtData` cloud endpoint.
 *
 * The result is cached per-SN in localStorage so a second connect to the same
 * robot doesn't need to re-prompt for the BLE key.
 */

import { cloudApi } from './unitree-cloud';
import { loadPublicKey, rsaEncrypt, type RsaPadding } from '../crypto/rsa';

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

/**
 * Fetch the cloud RSA pubkey, RSA-encrypt the SN, and POST it together with
 * the BLE GCM key to `device/bindExtData`. On success caches and returns the
 * 16-byte AES-128 key (hex string). Throws on network / API failure.
 */
export async function deriveAesKey(sn: string, gcmKeyB64: string): Promise<string> {
  const sn0 = sn.trim();
  const gcm0 = gcmKeyB64.trim();
  if (!sn0) throw new Error('SN missing');
  if (!gcm0) throw new Error('GCM key missing');

  const pubKeyB64 = await cloudApi.getPubKey();
  if (!pubKeyB64) throw new Error('system/pubKey returned empty body');

  // Diagnostic: surface enough about the inputs to triage the
  // "sk decode error" 500 from `device/bindExtData` without leaking the
  // BLE key body. SN is fine to log — it's already in the URL bar of the
  // device-detail page.
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

  // Try each padding scheme in turn until one isn't rejected by the cloud.
  // The 1.9.3 apk uses PKCS1-v1.5; some newer cloud rollouts appear to require
  // OAEP. We log which one wins so it can be pinned later.
  const schemes: RsaPadding[] = ['PKCS1-V1_5', 'OAEP-SHA1', 'OAEP-SHA256'];
  let lastErr: unknown = null;
  for (const padding of schemes) {
    try {
      const snEncrypted = rsaEncrypt(sn0, publicKey, padding);
      console.log(`[bindExtData] trying padding=${padding} snEncrypted length=${snEncrypted.length}`);
      const aesKey = await cloudApi.bindExtData(gcm0, sn0, snEncrypted);
      if (!aesKey) throw new Error('empty key in response');
      console.log(`[bindExtData] padding=${padding} succeeded → key length=${aesKey.length}`);
      setCachedAesKey(sn0, aesKey);
      return aesKey;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bindExtData] padding=${padding} failed: ${msg}`);
      lastErr = e;
      // Only loop on cloud-side decode errors; bail immediately on network /
      // cipher / other errors that wouldn't change with a different padding.
      if (!msg.toLowerCase().includes('decode') && !msg.toLowerCase().includes('error 500')) {
        throw e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('bindExtData rejected every RSA padding tried');
}

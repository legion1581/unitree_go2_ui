/**
 * AES-128 key cache + RSA helpers used by the cloud bind / unbind flow.
 *
 * The 16-byte AES-128 key (`data2=3` WebRTC auth) is derived server-side
 * during `device/bind` from the 344-char extData blob and surfaced as
 * `dev.key` on `device/bind/list`. We just cache it locally per SN so
 * the connect path can pick it up without a round-trip to the cloud.
 */

import { cloudApi } from './unitree-cloud';
import { loadPublicKey, rsaEncrypt } from '../crypto/rsa';

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
 * RSA-encrypt the SN with the cloud's RSA public key (PKCS#1 v1.5 padding,
 * matching the apk's `RSAUtil.encodeString`). Used by every endpoint that
 * accepts an RSA-wrapped SN — `device/bind` and `device/unbind`. Caller
 * passes the result through as the `sn` field.
 */
export async function rsaEncryptSn(sn: string): Promise<string> {
  const sn0 = sn.trim();
  if (!sn0) throw new Error('SN missing');
  const pubKeyB64 = await cloudApi.getPubKey();
  if (!pubKeyB64) throw new Error('system/pubKey returned empty body');
  const publicKey = loadPublicKey(pubKeyB64.trim());
  return rsaEncrypt(sn0, publicKey, 'PKCS1-V1_5');
}

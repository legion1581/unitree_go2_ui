/**
 * Derive the 16-byte AES-128 key used for WebRTC `data2=3` SDP authentication.
 *
 * Wire shape — verified against the apk's `device/bind`, `device/unbind`,
 * and `device/bindExtData` (all pass RSA-encrypted SN as the `sn` field):
 *
 *   POST device/bindExtData
 *   extData=<44-char base64 BLE GCM key>
 *   sn=<base64(RSA(public_key, plain SN))>
 *
 * Response is `BaseResp<String>` where `data` is the 16-byte AES-128 key
 * as a hex string. The 1.9.3 apk does no AES decryption on the response —
 * it stores `baseResp.data` straight into `gcmKey` LiveData.
 *
 * Cached per-SN in localStorage so a second connect to the same robot
 * doesn't need to re-derive.
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

  // Try each padding scheme in turn — the apk uses PKCS1-v1.5, but if the
  // cloud has been updated to require OAEP we want to surface that quickly.
  const schemes: RsaPadding[] = ['PKCS1-V1_5', 'OAEP-SHA1', 'OAEP-SHA256'];
  let lastErr: unknown = null;
  for (const padding of schemes) {
    try {
      const snEncrypted = rsaEncrypt(sn0, publicKey, padding);
      console.log(`[bindExtData] trying padding=${padding} snEncrypted length=${snEncrypted.length}`);
      const aesKey = await cloudApi.bindExtData(gcm0, snEncrypted);
      if (!aesKey) throw new Error('empty data in response');
      console.log(`[bindExtData] padding=${padding} succeeded → key length=${aesKey.length}`);
      setCachedAesKey(sn0, aesKey);
      return aesKey;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bindExtData] padding=${padding} failed: ${msg}`);
      lastErr = e;
      if (!msg.toLowerCase().includes('decode') && !msg.toLowerCase().includes('error 500')) {
        throw e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('bindExtData rejected every RSA padding tried');
}

/**
 * Diagnostic helper: hit `webrtc/account`, the apk-verified endpoint that
 * uses the same RSA-encrypted-payload pattern as `device/bindExtData`. If
 * this returns successfully, our RSA encryption pipeline is fine and any
 * failure on `bindExtData` is endpoint-specific (auth scope, region, etc).
 * If this also fails with `"sk decode error"`, RSA itself is the problem.
 *
 * Body: `sn=<plain>&sk=<RSA(random_aes_key)>`. Response is AES-CBC of
 * TurnServerInfo, which we don't need — we only check the `code`.
 */
export async function testRsaPipeline(sn: string): Promise<{ ok: boolean; detail: string }> {
  const sn0 = sn.trim();
  if (!sn0) return { ok: false, detail: 'SN missing' };

  const pubKeyB64 = await cloudApi.getPubKey();
  if (!pubKeyB64) return { ok: false, detail: 'system/pubKey returned empty body' };

  const publicKey = loadPublicKey(pubKeyB64.trim());
  // Reuse the same random-AES-key generator used elsewhere.
  const { generateAesKey } = await import('../crypto/aes');
  const aesKey = generateAesKey();
  const sk = rsaEncrypt(aesKey, publicKey, 'PKCS1-V1_5');
  console.log(`[testRSA] sn='${sn0}', sk length=${sk.length}, modulus=${publicKey.n.bitLength()}-bit`);

  try {
    const data = await cloudApi.post<string>('webrtc/account', { sn: sn0, sk });
    return { ok: true, detail: `webrtc/account OK, response data length=${data?.length ?? 0}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `webrtc/account failed: ${msg}` };
  }
}

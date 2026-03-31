import forge from 'node-forge';

export function generateAesKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function aesEncrypt(data: string, key: string): Promise<string> {
  const cipher = forge.cipher.createCipher('AES-ECB', key);
  cipher.start();
  cipher.update(forge.util.createBuffer(forge.util.encodeUtf8(data)));
  cipher.finish();
  return forge.util.encode64(cipher.output.getBytes());
}

export async function aesDecrypt(encryptedBase64: string, key: string): Promise<string> {
  const encrypted = forge.util.decode64(encryptedBase64);
  const decipher = forge.cipher.createDecipher('AES-ECB', key);
  decipher.start();
  decipher.update(forge.util.createBuffer(encrypted));
  const ok = decipher.finish();
  if (!ok) throw new Error('AES-ECB decryption failed (bad padding)');
  return forge.util.decodeUtf8(decipher.output.getBytes());
}

// Static AES-GCM key for con_notify `data2 === 2` (legacy Go2 / G1 < 1.5.1).
// Matches `AESGCMUtil.keyBytes` in the Unitree apk. For G1 ≥ 1.5.1 the robot
// sends `data2 === 3` and the per-device 16-byte key from `dev.key`
// (returned by `device/bind/list`) is used instead — see `aesGcmDecrypt(_, key)`.
const CON_NOTIFY_KEY = new Uint8Array([
  232, 86, 130, 189, 22, 84, 155, 0, 142, 4, 166, 104, 43, 179, 235, 227,
]);

/**
 * AES-GCM decrypt a base64 payload with the layout the Unitree firmware uses:
 *   [ ciphertext | nonce(12) | tag(16) ]
 *
 * Pass `key` (16 / 24 / 32 raw bytes) to override the legacy static key —
 * required for `data2 === 3` payloads.
 *
 * Implemented via node-forge (not WebCrypto) so it works in non-secure
 * contexts — i.e. when the dev server is opened from a LAN URL like
 * `http://192.168.x.x:5173`, where `crypto.subtle` is undefined.
 */
export async function aesGcmDecrypt(
  encryptedBase64: string,
  key: Uint8Array = CON_NOTIFY_KEY,
): Promise<string> {
  const raw = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));

  const ciphertext = raw.slice(0, raw.length - 28);
  const nonce = raw.slice(raw.length - 28, raw.length - 16);
  const tag = raw.slice(raw.length - 16);

  const keyBuf = forge.util.createBuffer(String.fromCharCode(...key));
  const iv = forge.util.createBuffer(String.fromCharCode(...nonce));

  const decipher = forge.cipher.createDecipher('AES-GCM', keyBuf);
  decipher.start({ iv, tag: forge.util.createBuffer(String.fromCharCode(...tag)) });
  decipher.update(forge.util.createBuffer(String.fromCharCode(...ciphertext)));
  const ok = decipher.finish();
  if (!ok) throw new Error('AES-GCM decryption failed (authentication tag mismatch)');

  return forge.util.decodeUtf8(decipher.output.getBytes());
}

/** Convert a hex-encoded AES key (e.g. `dev.key` from `device/bind/list`) to raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex key length must be even');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

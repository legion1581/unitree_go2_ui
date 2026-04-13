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

// AES-GCM decryption for con_notify responses (data2 === 2)
const CON_NOTIFY_KEY = new Uint8Array([
  232, 86, 130, 189, 22, 84, 155, 0, 142, 4, 166, 104, 43, 179, 235, 227,
]);

export async function aesGcmDecrypt(encryptedBase64: string): Promise<string> {
  const raw = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));

  // Last 28 bytes: 12-byte nonce + 16-byte auth tag
  const ciphertext = raw.slice(0, raw.length - 28);
  const nonce = raw.slice(raw.length - 28, raw.length - 16);
  const tag = raw.slice(raw.length - 16);

  const key = forge.util.createBuffer(String.fromCharCode(...CON_NOTIFY_KEY));
  const iv = forge.util.createBuffer(String.fromCharCode(...nonce));

  const decipher = forge.cipher.createDecipher('AES-GCM', key);
  decipher.start({ iv, tag: forge.util.createBuffer(String.fromCharCode(...tag)) });
  decipher.update(forge.util.createBuffer(String.fromCharCode(...ciphertext)));
  const ok = decipher.finish();
  if (!ok) throw new Error('AES-GCM decryption failed (authentication tag mismatch)');

  return forge.util.decodeUtf8(decipher.output.getBytes());
}

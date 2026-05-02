import forge from 'node-forge';

export function loadPublicKey(base64Der: string): forge.pki.rsa.PublicKey {
  const der = forge.util.decode64(base64Der);
  const asn1 = forge.asn1.fromDer(der);
  return forge.pki.publicKeyFromAsn1(asn1) as forge.pki.rsa.PublicKey;
}

export type RsaPadding = 'PKCS1-V1_5' | 'OAEP-SHA1' | 'OAEP-SHA256';

/**
 * RSA-encrypt `data` and return base64 of the concatenated cipher chunks.
 *
 * The Unitree apk's `RSAUtil.encryptData` uses `RSA/ECB/PKCS1Padding`
 * (PKCS#1 v1.5). The cloud's newer servers may only accept OAEP — we
 * surface a `padding` arg so callers can try both schemes.
 */
export function rsaEncrypt(
  data: string,
  publicKey: forge.pki.rsa.PublicKey,
  padding: RsaPadding = 'PKCS1-V1_5',
): string {
  const keySize = Math.ceil(publicKey.n.bitLength() / 8);
  // PKCS1 v1.5 padding overhead is 11 bytes; OAEP-SHA1 is 2*20+2=42; OAEP-SHA256 is 2*32+2=66.
  const maxChunk =
    padding === 'OAEP-SHA1'   ? keySize - 42
    : padding === 'OAEP-SHA256' ? keySize - 66
    :                             keySize - 11;

  const scheme = padding === 'PKCS1-V1_5' ? 'RSAES-PKCS1-V1_5' : 'RSA-OAEP';
  const schemeOpts: { md?: forge.md.MessageDigest } = {};
  if (padding === 'OAEP-SHA1')   schemeOpts.md = forge.md.sha1.create();
  if (padding === 'OAEP-SHA256') schemeOpts.md = forge.md.sha256.create();

  const dataBytes = forge.util.encodeUtf8(data);
  const chunks: string[] = [];

  for (let i = 0; i < dataBytes.length; i += maxChunk) {
    const chunk = dataBytes.substring(i, i + maxChunk);
    chunks.push(publicKey.encrypt(chunk, scheme, schemeOpts));
  }

  return forge.util.encode64(chunks.join(''));
}

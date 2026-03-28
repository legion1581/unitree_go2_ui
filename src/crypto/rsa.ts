import forge from 'node-forge';

export function loadPublicKey(base64Der: string): forge.pki.rsa.PublicKey {
  const der = forge.util.decode64(base64Der);
  const asn1 = forge.asn1.fromDer(der);
  return forge.pki.publicKeyFromAsn1(asn1) as forge.pki.rsa.PublicKey;
}

export function rsaEncrypt(data: string, publicKey: forge.pki.rsa.PublicKey): string {
  const keySize = Math.ceil(publicKey.n.bitLength() / 8);
  const maxChunk = keySize - 11; // PKCS1 v1.5 padding overhead

  const dataBytes = forge.util.encodeUtf8(data);
  const chunks: string[] = [];

  for (let i = 0; i < dataBytes.length; i += maxChunk) {
    const chunk = dataBytes.substring(i, i + maxChunk);
    chunks.push(publicKey.encrypt(chunk, 'RSAES-PKCS1-V1_5'));
  }

  return forge.util.encode64(chunks.join(''));
}

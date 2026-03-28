import forge from 'node-forge';
import type { DataChannelMessage } from '../types';
import { DATA_CHANNEL_TYPE } from './topics';
import type { WebRTCConnection } from '../connection/webrtc';

export function handleValidation(
  msg: DataChannelMessage,
  webrtc: WebRTCConnection,
  onValidated: () => void,
): void {
  if (msg.type !== DATA_CHANNEL_TYPE.VALIDATION) return;

  const data = msg.data as string;

  console.log('[go2:val] Validation message data:', JSON.stringify(data));

  if (data === 'Validation Ok.') {
    console.log('[go2:val] Validation OK!');
    onValidated();
    return;
  }

  // Device sent a hex key challenge — respond with MD5
  // Python ref: md5(input) → hex string → bytes.fromhex() → base64
  const md5Input = `UnitreeGo2_${data}`;
  const md5Hex = forge.md.md5.create().update(md5Input).digest().toHex();

  // Convert hex string to raw bytes, then base64 encode
  const md5Bytes = forge.util.hexToBytes(md5Hex);
  const responseB64 = forge.util.encode64(md5Bytes);

  console.log('[go2:val] Challenge key:', data);
  console.log('[go2:val] MD5 hex:', md5Hex);
  console.log('[go2:val] Base64 response:', responseB64);

  webrtc.send({
    type: DATA_CHANNEL_TYPE.VALIDATION,
    topic: '',
    data: responseB64,
  });
  console.log('[go2:val] Sent validation response');
}

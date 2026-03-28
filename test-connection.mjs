/**
 * Connection test script for Unitree Go2
 * Tests the full con_notify → con_ing SDP exchange from Node.js
 * Usage: node test-connection.mjs [robot-ip]
 */

import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

const ROBOT_IP = process.argv[2] || '192.168.0.181';
const PORT = 9991;

const CON_NOTIFY_KEY = Buffer.from([232, 86, 130, 189, 22, 84, 155, 0, 142, 4, 166, 104, 43, 179, 235, 227]);

function httpPost(host, port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, port, path, method: 'POST', headers: headers || {} };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('Timeout')); });
    if (body) req.end(body); else req.end();
  });
}

function decryptConNotifyGcm(encryptedB64) {
  const raw = Buffer.from(encryptedB64, 'base64');
  const ciphertext = raw.slice(0, raw.length - 28);
  const nonce = raw.slice(raw.length - 28, raw.length - 16);
  const tag = raw.slice(raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', CON_NOTIFY_KEY, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

function calcPathEnding(data1) {
  const lookup = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const tail = data1.slice(-10);
  let path = '';
  for (let i = 0; i < tail.length; i += 2) {
    const idx = lookup.indexOf(tail[i + 1]);
    path += idx >= 0 ? idx.toString() : '0';
  }
  return path;
}

// AES-256-ECB encrypt with PKCS7 padding
function aesEcbEncrypt(data, keyStr) {
  const key = Buffer.from(keyStr, 'utf-8');
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]).toString('base64');
}

function aesEcbDecrypt(dataB64, keyStr) {
  const key = Buffer.from(keyStr, 'utf-8');
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf-8');
}

function generateAesKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

function rsaEncrypt(data, pubKeyPem) {
  const pubKey = crypto.createPublicKey({ key: Buffer.from(pubKeyPem, 'base64'), format: 'der', type: 'spki' });
  const keySize = 256; // 2048-bit RSA = 256 bytes
  const maxChunk = keySize - 11;
  const dataBytes = Buffer.from(data, 'utf-8');
  const chunks = [];
  for (let i = 0; i < dataBytes.length; i += maxChunk) {
    const chunk = dataBytes.slice(i, i + maxChunk);
    chunks.push(crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, chunk));
  }
  return Buffer.concat(chunks).toString('base64');
}

async function testPortScan() {
  console.log(`=== Port scan on ${ROBOT_IP} ===\n`);
  for (const p of [8080, 8081, 9991, 9992]) {
    const open = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.on('error', () => resolve(false));
      sock.connect(p, ROBOT_IP);
    });
    console.log(`  Port ${p}: ${open ? 'OPEN' : 'closed'}`);
  }
  console.log('');
}

async function testConNotify() {
  console.log(`=== Step 1: con_notify ===\n`);
  const resp = await httpPost(ROBOT_IP, PORT, '/con_notify', null, null);
  console.log(`  Status: ${resp.status}`);

  const decoded = Buffer.from(resp.body, 'base64').toString('utf-8');
  const json = JSON.parse(decoded);
  console.log(`  data2 (encryption flag): ${json.data2}`);

  let data1 = json.data1;
  if (json.data2 === 2) {
    data1 = decryptConNotifyGcm(json.data1);
    console.log(`  GCM decryption: OK`);
  }

  const pubKeyB64 = data1.slice(10, data1.length - 10);
  const pathEnding = calcPathEnding(data1);
  console.log(`  Public key extracted: ${pubKeyB64.slice(0, 30)}...`);
  console.log(`  Path ending: ${pathEnding}`);
  console.log(`  [PASS]\n`);

  return { pubKeyB64, pathEnding };
}

async function testConIng(pubKeyB64, pathEnding) {
  console.log(`=== Step 2: con_ing_${pathEnding} (real SDP exchange) ===\n`);

  // Create a minimal fake SDP offer (not a real WebRTC SDP, just to test the crypto pipeline)
  const fakeSdp = JSON.stringify({
    id: 'STA_localNetwork',
    sdp: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n',
    type: 'offer',
    token: '',
  });

  const aesKey = generateAesKey();
  console.log(`  AES key: ${aesKey}`);

  const encryptedSdp = aesEcbEncrypt(fakeSdp, aesKey);
  console.log(`  Encrypted SDP length: ${encryptedSdp.length}`);

  const encryptedKey = rsaEncrypt(aesKey, pubKeyB64);
  console.log(`  RSA-encrypted AES key length: ${encryptedKey.length}`);

  const body = JSON.stringify({
    data1: encryptedSdp,
    data2: encryptedKey,
  });

  console.log(`  Request body length: ${body.length}`);

  try {
    const resp = await httpPost(ROBOT_IP, PORT, `/con_ing_${pathEnding}`, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    console.log(`  Response status: ${resp.status}`);
    console.log(`  Response body length: ${resp.body.length}`);

    if (resp.body.length > 0 && resp.status === 200) {
      try {
        const decrypted = aesEcbDecrypt(resp.body, aesKey);
        const answerJson = JSON.parse(decrypted);
        console.log(`  Answer SDP type: ${answerJson.type}`);
        console.log(`  Answer SDP starts with: ${(answerJson.sdp || '').slice(0, 60)}...`);

        if (answerJson.sdp === 'reject') {
          console.log(`\n  [WARN] Robot rejected — another client may be connected`);
        } else {
          console.log(`\n  [PASS] Full SDP exchange successful!`);
        }
      } catch (e) {
        console.log(`  Decrypt/parse error: ${e.message}`);
        console.log(`  Raw response (first 100): ${resp.body.slice(0, 100)}`);
        console.log(`\n  [FAIL] Could not decrypt answer`);
      }
    } else {
      console.log(`  [FAIL] Unexpected response`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
    console.log(`\n  [FAIL] con_ing request failed`);
  }
}

async function main() {
  console.log(`\nUnitree Go2 Connection Test — ${ROBOT_IP}\n${'='.repeat(50)}\n`);

  await testPortScan();

  try {
    const { pubKeyB64, pathEnding } = await testConNotify();
    await testConIng(pubKeyB64, pathEnding);
  } catch (err) {
    console.error(`\n  FATAL: ${err.message}`);
  }

  console.log('\nDone!');
}

main().catch(console.error);

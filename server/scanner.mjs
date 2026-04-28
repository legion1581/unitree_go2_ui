/**
 * UDP Multicast Scanner for Unitree robots (Go2 + G1).
 *
 * Wire protocol — same on both, only the multicast group(s) differ:
 *   - Send query to port 10131: {"name":"unitree_dapengche"}
 *   - Receive responses on port 10134: {"sn":"<serial>","ip":"<ip>"}
 *
 * Multicast groups per family:
 *   - Go2: 231.1.1.1
 *   - G1:  231.1.1.2 + 239.255.1.1   (matches multicast_responder.py on
 *          /unitree/.../webrtc_dds_bridge/ in G1 firmware 1.5.1)
 *
 * Exposes a tiny HTTP API on port 3001:
 *   GET /scan?family=Go2|G1  → scans and returns JSON array of found robots
 *   GET /scan?timeout=5000   → custom timeout in ms (default 3000)
 */

import dgram from 'node:dgram';
import http from 'node:http';

const FAMILY_GROUPS = {
  Go2: ['231.1.1.1'],
  G1:  ['231.1.1.2', '239.255.1.1'],
};
const QUERY_PORT = 10131;
const RECV_PORT = 10134;
const QUERY_MSG = JSON.stringify({ name: 'unitree_dapengche' });
const DEFAULT_TIMEOUT = 3000;
const HTTP_PORT = parseInt(process.env.SCANNER_PORT || '3001', 10);

/**
 * Perform a UDP multicast scan for a family of robots.
 * @param {'Go2' | 'G1'} family  Which multicast group set to use.
 * @param {number} timeoutMs     How long to listen for responses.
 * @returns {Promise<Array<{sn: string, ip: string}>>}
 */
function scanForRobots(family = 'Go2', timeoutMs = DEFAULT_TIMEOUT) {
  const groups = FAMILY_GROUPS[family] || FAMILY_GROUPS.Go2;
  return new Promise((resolve, reject) => {
    const results = [];
    const seen = new Set();

    const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    receiver.on('error', (err) => {
      receiver.close();
      reject(err);
    });

    receiver.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.sn && data.ip && !seen.has(data.sn)) {
          seen.add(data.sn);
          results.push({ sn: data.sn, ip: data.ip });
          console.log(`[scanner] Found ${family} robot: SN=${data.sn} IP=${data.ip}`);
        }
      } catch { /* ignore non-JSON */ }
    });

    receiver.bind(RECV_PORT, () => {
      for (const g of groups) {
        try { receiver.addMembership(g); } catch { /* may already be member */ }
      }

      const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const buf = Buffer.from(QUERY_MSG);
      let sent = 0;
      const sendQuery = () => {
        for (const g of groups) {
          sender.send(buf, 0, buf.length, QUERY_PORT, g, (err) => {
            if (err) console.warn(`[scanner] Send error to ${g}:`, err.message);
          });
        }
        sent++;
        if (sent < 3) setTimeout(sendQuery, 200);
        else setTimeout(() => sender.close(), 100);
      };
      sendQuery();
    });

    setTimeout(() => {
      for (const g of groups) {
        try { receiver.dropMembership(g); } catch { /* not a member */ }
      }
      receiver.close();
      resolve(results);
    }, timeoutMs);
  });
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);

  if (url.pathname === '/scan' && req.method === 'GET') {
    const timeout = parseInt(url.searchParams.get('timeout') || String(DEFAULT_TIMEOUT), 10);
    const family = url.searchParams.get('family') || 'Go2';
    console.log(`[scanner] Scan requested (family=${family}, timeout=${timeout}ms)`);

    try {
      const robots = await scanForRobots(family, timeout);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ robots }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(HTTP_PORT, () => {
  console.log(`[scanner] UDP multicast scanner listening on http://localhost:${HTTP_PORT}`);
  console.log(`[scanner] GET /scan to discover Go2 robots on the network`);
});

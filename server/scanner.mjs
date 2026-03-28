/**
 * UDP Multicast Scanner for Unitree Go2 robots.
 *
 * Protocol (from multicast_scanner.py):
 *   - Multicast group: 231.1.1.1
 *   - Send query to port 10131: {"name":"unitree_dapengche"}
 *   - Receive responses on port 10134: {"sn":"<serial>","ip":"<ip>"}
 *
 * Exposes a tiny HTTP API on port 3001:
 *   GET /scan          → scans and returns JSON array of found robots
 *   GET /scan?timeout=5000  → custom timeout in ms (default 3000)
 */

import dgram from 'node:dgram';
import http from 'node:http';

const MULTICAST_GROUP = '231.1.1.1';
const QUERY_PORT = 10131;
const RECV_PORT = 10134;
const QUERY_MSG = JSON.stringify({ name: 'unitree_dapengche' });
const DEFAULT_TIMEOUT = 3000;
const HTTP_PORT = parseInt(process.env.SCANNER_PORT || '3001', 10);

/**
 * Perform a UDP multicast scan for Go2 robots.
 * @param {number} timeoutMs  How long to listen for responses.
 * @returns {Promise<Array<{sn: string, ip: string}>>}
 */
function scanForRobots(timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const results = [];
    const seen = new Set();

    // Receiver socket (listen on RECV_PORT for responses)
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
          console.log(`[scanner] Found robot: SN=${data.sn} IP=${data.ip}`);
        }
      } catch { /* ignore non-JSON */ }
    });

    receiver.bind(RECV_PORT, () => {
      try {
        receiver.addMembership(MULTICAST_GROUP);
      } catch { /* may already be member */ }

      // Send the query
      const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const buf = Buffer.from(QUERY_MSG);

      // Send multiple times for reliability
      let sent = 0;
      const sendQuery = () => {
        sender.send(buf, 0, buf.length, QUERY_PORT, MULTICAST_GROUP, (err) => {
          if (err) console.warn('[scanner] Send error:', err.message);
          sent++;
          if (sent < 3) setTimeout(sendQuery, 200);
          else sender.close();
        });
      };
      sendQuery();
    });

    // Resolve after timeout
    setTimeout(() => {
      try { receiver.dropMembership(MULTICAST_GROUP); } catch {}
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
    console.log(`[scanner] Scan requested (timeout=${timeout}ms)`);

    try {
      const robots = await scanForRobots(timeout);
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

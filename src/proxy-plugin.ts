import type { Plugin } from 'vite';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';

// ── UDP Multicast Scanner (embedded) ──

const MULTICAST_GROUP = '231.1.1.1';
const QUERY_PORT = 10131;
const RECV_PORT = 10134;
const QUERY_MSG = JSON.stringify({ name: 'unitree_dapengche' });
const DEFAULT_SCAN_TIMEOUT = 3000;

function scanForRobots(timeoutMs = DEFAULT_SCAN_TIMEOUT): Promise<Array<{ sn: string; ip: string }>> {
  return new Promise((resolve, reject) => {
    const results: Array<{ sn: string; ip: string }> = [];
    const seen = new Set<string>();

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
      try { receiver.addMembership(MULTICAST_GROUP); } catch { /* may already be member */ }

      const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const buf = Buffer.from(QUERY_MSG);
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

    setTimeout(() => {
      try { receiver.dropMembership(MULTICAST_GROUP); } catch {}
      receiver.close();
      resolve(results);
    }, timeoutMs);
  });
}

// ── Vite Plugin ──

export function robotProxyPlugin(): Plugin {
  return {
    name: 'robot-proxy',
    configureServer(server) {
      // Handle /scan requests directly (no separate scanner process needed)
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');

        if (url.pathname === '/scan' && req.method === 'GET') {
          const timeout = parseInt(url.searchParams.get('timeout') || String(DEFAULT_SCAN_TIMEOUT), 10);
          console.log(`[scanner] Scan requested (timeout=${timeout}ms)`);

          scanForRobots(timeout)
            .then((robots) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ robots }));
            })
            .catch((err) => {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: (err as Error).message }));
            });
          return;
        }

        // Proxy Unitree cloud API requests to avoid CORS
        if (url.pathname.startsWith('/unitree-api/')) {
          const targetPath = req.url!.replace('/unitree-api', '');
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            // Forward all custom headers
            for (const [key, val] of Object.entries(req.headers)) {
              if (typeof val === 'string' && key !== 'host' && key !== 'origin' && key !== 'referer') {
                headers[key] = val;
              }
            }
            if (body.length > 0) {
              headers['content-length'] = body.length.toString();
            }

            const proxyReq = https.request(
              {
                hostname: 'global-robot-api.unitree.com',
                port: 443,
                path: targetPath,
                method: req.method,
                headers,
              },
              (proxyRes) => {
                res.statusCode = proxyRes.statusCode ?? 500;
                if (proxyRes.headers['content-type']) {
                  res.setHeader('Content-Type', proxyRes.headers['content-type']);
                }
                proxyRes.pipe(res);
              },
            );

            proxyReq.on('error', (err) => {
              res.statusCode = 502;
              res.end(`Proxy error: ${err.message}`);
            });

            if (body.length > 0) {
              proxyReq.end(body);
            } else {
              proxyReq.end();
            }
          });
          return;
        }

        if (!req.url?.startsWith('/robot-api/')) {
          return next();
        }

        const targetHost = req.headers['x-robot-host'] as string;
        if (!targetHost) {
          res.statusCode = 400;
          res.end('Missing X-Robot-Host header');
          return;
        }

        const path = req.url.replace('/robot-api', '');
        const [host, portStr] = targetHost.split(':');
        const port = parseInt(portStr, 10);

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);

          const headers: Record<string, string> = {};
          if (body.length > 0) {
            headers['Content-Type'] = req.headers['content-type'] || 'application/json';
            headers['Content-Length'] = body.length.toString();
          }

          const proxyReq = http.request(
            { hostname: host, port, path, method: req.method, headers },
            (proxyRes) => {
              res.statusCode = proxyRes.statusCode ?? 500;
              if (proxyRes.headers['content-type']) {
                res.setHeader('Content-Type', proxyRes.headers['content-type']);
              }
              proxyRes.pipe(res);
            },
          );

          proxyReq.on('error', (err) => {
            res.statusCode = 502;
            res.end(`Proxy error: ${err.message}`);
          });

          if (body.length > 0) {
            proxyReq.end(body);
          } else {
            proxyReq.end();
          }
        });
      });
    },
  };
}

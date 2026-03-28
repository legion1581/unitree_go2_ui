/**
 * Network scanner for auto-detecting Unitree Go2 robots.
 *
 * Uses the /scan endpoint served by the Vite dev server plugin (proxy-plugin.ts)
 * which performs UDP multicast on 231.1.1.1:10131.
 */

export interface ScanResult {
  sn: string;
  ip: string;
}

/** Scan for Go2 robots via the built-in UDP multicast scanner. */
export async function scanForRobots(
  onProgress?: (msg: string) => void,
): Promise<ScanResult[]> {
  onProgress?.('Starting UDP multicast scan...');

  try {
    const resp = await fetch(`/scan?timeout=3000`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      throw new Error(`Scanner returned ${resp.status}`);
    }

    const data = await resp.json() as { robots: ScanResult[] };

    if (data.robots.length > 0) {
      onProgress?.(`Found ${data.robots.length} robot(s)`);
      return data.robots;
    }

    onProgress?.('No robots found on network');
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      onProgress?.('Scanner service not running. Start with: node server/scanner.mjs');
    } else {
      onProgress?.(`Scan failed: ${msg}`);
    }
    return [];
  }
}

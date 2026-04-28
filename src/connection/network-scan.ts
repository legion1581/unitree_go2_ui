/**
 * Network scanner for auto-detecting Unitree robots.
 *
 * Uses the /scan endpoint served by the Vite dev server plugin (proxy-plugin.ts)
 * which performs UDP multicast on the family-specific groups:
 *   * Go2: 231.1.1.1
 *   * G1:  231.1.1.2 + 239.255.1.1
 * Both families use the same query port (10131) and reply port (10134).
 */

import type { RobotFamily } from '../api/unitree-cloud';

export interface ScanResult {
  sn: string;
  ip: string;
}

/** Scan for robots of the given family via the built-in UDP multicast scanner. */
export async function scanForRobots(
  family: RobotFamily,
  onProgress?: (msg: string) => void,
): Promise<ScanResult[]> {
  onProgress?.(`Starting UDP multicast scan for ${family}...`);

  try {
    const resp = await fetch(`/scan?family=${encodeURIComponent(family)}&timeout=3000`, {
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

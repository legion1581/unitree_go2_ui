/**
 * Robot fault catalog — code/source → human-readable label.
 *
 * Sourced from the Unitree Go2 APK 1.12.4 string resources
 * (res/values/strings.xml), keys `app_error_source_<src>` and
 * `app_error_code_<src>_<hexCode>`. The wire format is `[ts, source, code]`
 * triples; lookups use the code's lowercase, unpadded hex representation
 * (matches the Python reference handler's `integer_to_hex_string`).
 *
 * Codes are single fault bits (1, 2, 4, 8, 16, 32, …) — each fault arrives
 * as its own entry, not as a packed bitmask.
 */

export type ErrorRecord = {
  timestamp: number;   // unix seconds
  source: number;      // 100, 200, 300, 400, 500, 600, 700
  code: number;        // single bit value (1, 2, 4, 8, 16, 32, …)
};

export type DecodedError = ErrorRecord & {
  sourceLabel: string;
  codeLabel: string;
  key: string;         // "<source>:<code>" — stable id for dedup
};

const SOURCE_LABELS: Record<number, string> = {
  100: 'Communication firmware error',
  200: 'Communication firmware error',
  300: 'Motor malfunction',
  400: 'Radar malfunction',
  500: 'UWB malfunction',
  600: 'Motion Control',
  700: 'BMS error',
};

// Keyed by `<source>_<hexCode>` (lowercase, unpadded — e.g. "300_100" = bit 8).
// Wheel-specific overrides (300_40, 300_80) appear only on the wheeled variant
// in the APK; we include them in the same table since they don't conflict
// with non-wheeled entries.
const CODE_LABELS: Record<string, string> = {
  // 100 — Communication firmware
  '100_1':   'DDS message timeout',
  '100_2':   'Distribution switch abnormal',
  '100_10':  'Battery communication error',
  '100_20':  'Abnormal mote control communication',
  '100_40':  'MCU communication error',
  '100_80':  'Motor communication error',
  // 200 — Cooling fans
  '200_1':   'Rear left fan jammed',
  '200_2':   'Rear right fan jammed',
  '200_4':   'Front fan jammed',
  // 300 — Motor
  '300_1':   'Overcurrent',
  '300_2':   'Overvoltage',
  '300_4':   'Driver overheating',
  '300_8':   'Generatrix undervoltage',
  '300_10':  'Winding overheating',
  '300_20':  'Encoder abnormal',
  '300_40':  'Calibration data abnormality',     // wheeled variant
  '300_80':  'Abnormal reset',                    // wheeled variant
  '300_100': 'Motor communication interruption',
  // 400 — Radar / LiDAR
  '400_1':   'Motor rotate speed abnormal',
  '400_2':   'PointCloud data abnormal',
  '400_4':   'Serial port data abnormal',
  '400_10':  'Abnormal dirt index',
  // 500 — UWB
  '500_1':   'UWB serial port open abnormal',
  '500_2':   'Robot dog information retrieval abnormal',
  // 600 — Motion control / thermal
  '600_4':   'Overheating software protection',
  '600_8':   'Low battery software protection',
  // 700 — BMS (no per-bit strings shipped in the APK; fallback only)
};

/** Lowercase, unpadded hex — matches the APK string-resource key style. */
export function codeToHex(code: number): string {
  return code.toString(16);
}

export function lookupSource(source: number): string {
  return SOURCE_LABELS[source] ?? `Source ${source}`;
}

export function lookupCode(source: number, code: number): string {
  return CODE_LABELS[`${source}_${codeToHex(code)}`] ?? `Code 0x${codeToHex(code)}`;
}

export function decodeError(record: ErrorRecord): DecodedError {
  return {
    ...record,
    sourceLabel: lookupSource(record.source),
    codeLabel: lookupCode(record.source, record.code),
    key: `${record.source}:${record.code}`,
  };
}

export function errorKey(source: number, code: number): string {
  return `${source}:${code}`;
}

# Error handling

Runtime fault visualization for the connected robot (Go2 and G1) — surfaces
firmware-reported faults the moment they appear, keeps an authoritative active
set in memory, and exposes three ways to view them: a NavBar badge, a
click-anchored popover, and a full-screen Errors page (also reachable from
the Hub).

## Wire protocol

Faults arrive on the WebRTC **data channel**, not on a topic. Three message
types share one payload shape — an array of triples
`[timestamp, error_source, error_code]`:

| `type`        | Direction    | `data`                              | Meaning                                                                 |
|---------------|--------------|-------------------------------------|-------------------------------------------------------------------------|
| `errors`      | Robot → app  | `[[ts, src, code], …]`              | Authoritative snapshot of every fault currently active. Sent periodically and immediately after validation. |
| `add_error`   | Robot → app  | `[ts, src, code]` *(single triple)* | A new fault just appeared.                                              |
| `rm_error`    | Robot → app  | `[ts, src, code]` *(single triple)* | An existing fault just cleared.                                         |

Field types:

- **`timestamp`** — unix seconds (integer). The "appeared at" time of the fault.
- **`error_source`** — integer category, see the [source table](#sources).
- **`error_code`** — single bit value. One active fault per entry — never
  packed bitmasks. Multiple simultaneous faults in the same source arrive as
  multiple triples. Go2 codes stay inside 9 bits (max `0x100`); G1 widens the
  field to 28+ bits (max `0x10000000` seen) — still well inside `Number.MAX_SAFE_INTEGER`,
  so no `BigInt` handling is needed.

A typical first `errors` message after validation looks like:

```json
{
  "type": "errors",
  "data": [
    [1715890123, 300, 16],
    [1715890145, 200, 1]
  ]
}
```

Decoded: "Winding overheating (motor)" since 21s ago, and "Rear left fan jammed"
since just now.

## Reconciliation model

The store treats `errors` as the source of truth and `add_error` / `rm_error`
as deltas that keep the UI in lock-step between snapshots:

- **`errors`** → `replaceAll(triples)`. Existing entries keep their original
  timestamp so the "appeared at" label doesn't jitter on resync.
- **`add_error`** → insert. **No-op if the `(source, code)` key already
  exists**, so a snapshot/delta race during reconnect doesn't double-fire.
- **`rm_error`** → remove by `(source, code)`. No-op if not present.
- **WebRTC disconnect** → store is cleared.

This lets the UI react in real time (a new fault toasts the instant the firmware
detects it) without ever drifting indefinitely — the next snapshot resyncs the
full active set.

## UI surfaces

| Surface | Where | Behavior |
|---|---|---|
| **Toast** | Bottom-right, floating | Slides in on every `add_error`. Snapshot replays are silent so reconnects don't spam. 4.5s auto-dismiss; click to dismiss early. |
| **NavBar badge** | Top-right of the Control screen | Red warning triangle + count chip. Visible only when active count > 0. Click opens the popover. |
| **Floating badge** | Top-right on Hub / Status / Services / Account / BT screens | Same icon + count, anchored as a persistent floating icon. Hidden on the Control screen (the NavBar badge takes over). |
| **Popover** | Anchored under whichever badge was clicked | Header with active count, up to four rows visible, scroll for more. Shows code label · source · code id · relative time. Closes on outside-click or when the active set empties. |
| **Errors page** | Reached via the Hub's *Errors* button | Full-screen grouped view. Faults are bucketed by source category with a section header. Each row shows the code label, a hex `0x…` chip with the bit value, and a two-line time stack (absolute clock + relative). |

## Sources

| ID            | Family   | Label                                | Notes                                                  |
|---------------|----------|--------------------------------------|--------------------------------------------------------|
| 100           | Go2 / G1 | Communication firmware error         | DDS, distribution switch, MCU, motor link, battery I²C |
| 200           | Go2 / G1 | Communication firmware error         | Cooling fans (front / rear-left / rear-right)          |
| 300           | Go2 / G1 | Motor malfunction                    | Overcurrent / overvoltage / encoder / thermals         |
| 301–399       | G1       | Motor *N* (= source − 300)           | Same code semantics as 300, attributed to one joint    |
| 400           | Go2 / G1 | Radar malfunction                    | LiDAR motor, point-cloud integrity, serial port, dirt  |
| 500           | Go2 / G1 | UWB malfunction                      | Serial open, info retrieval                            |
| 600           | Go2 / G1 | Motion Control                       | Software thermal + low-battery protections             |
| 700           | Go2 / G1 | BMS error                            | Battery management faults                              |
| 800           | G1       | Chassis error                        | Humanoid-specific physical fault                       |
| 900           | G1       | Power distribution switch anomaly    | Power-rail fault (source label only — no code labels shipped) |
| 1000          | G1       | Emergency Stop                       | E-stop triggered                                       |
| 3000–3999     | G1       | Motor *N* (= source mod 100)         | Alternate per-joint addressing — same 300 code bits    |

### Per-motor synthesis

G1 reports per-joint motor faults using two source-number conventions:
`301 + jointIdx` and `3000 + jointIdx`. Both ranges are resolved at lookup
time by [`lookupSource()`](../src/protocol/errors-catalog.ts) — they return
`"Motor N"` and share source `300`'s code-bit catalog via
[`lookupCode()`](../src/protocol/errors-catalog.ts), so the same overcurrent
/ encoder / overheat bits decode correctly whether the fault is attributed
generically (source 300) or to a specific joint.

## Sample codes

Codes are looked up by `(source, hex(code))`. A few representative entries:

| Source | Code (decimal / hex)              | Family   | Label                              |
|--------|-----------------------------------|----------|------------------------------------|
| 100    | 1   / `0x1`                       | Go2 / G1 | DDS message timeout                |
| 100    | 16  / `0x10`                      | Go2 / G1 | Battery communication error        |
| 100    | 128 / `0x80`                      | Go2 / G1 | Motor communication error          |
| 200    | 1   / `0x1`                       | Go2 / G1 | Rear left fan jammed               |
| 200    | 4   / `0x4`                       | Go2 / G1 | Front fan jammed                   |
| 300    | 1   / `0x1`                       | Go2 / G1 | Overcurrent                        |
| 300    | 4   / `0x4`                       | Go2 / G1 | Driver overheating                 |
| 300    | 16  / `0x10`                      | Go2 / G1 | Winding overheating                |
| 300    | 32  / `0x20`                      | Go2 / G1 | Encoder abnormal                   |
| 300    | 256 / `0x100`                     | Go2 / G1 | Motor communication interruption   |
| 300    | 4 096 / `0x1000`                  | G1       | Command anomaly                    |
| 300    | 65 536 / `0x10000`                | G1       | Status anomaly                     |
| 300    | 16 777 216 / `0x1000000`          | G1       | Motor humidity anomaly             |
| 300    | 33 554 432 / `0x2000000`          | G1       | Encoder remote                     |
| 300    | 67 108 864 / `0x4000000`          | G1       | MOS almost overheat                |
| 300    | 134 217 728 / `0x8000000`         | G1       | Encoder close                      |
| 300    | 268 435 456 / `0x10000000`        | G1       | Winding almost overheat            |
| 400    | 1   / `0x1`                       | Go2 / G1 | Motor rotate speed abnormal        |
| 400    | 2   / `0x2`                       | Go2 / G1 | PointCloud data abnormal           |
| 400    | 16  / `0x10`                      | Go2 / G1 | Abnormal dirt index                |
| 500    | 1   / `0x1`                       | Go2 / G1 | UWB serial port open abnormal      |
| 600    | 4   / `0x4`                       | Go2 / G1 | Overheating software protection    |
| 600    | 8   / `0x8`                       | Go2 / G1 | Low battery software protection    |

Unknown `(source, code)` pairs fall back to `Source <id>` and `Code 0x<hex>` so
the UI keeps working when the firmware introduces a new fault.

## Where this lives in the source

- [`src/protocol/errors-catalog.ts`](../src/protocol/errors-catalog.ts) — source/code label tables + `decodeError()` helper.
- [`src/protocol/error-store.ts`](../src/protocol/error-store.ts) — observable active-set, reconciliation rules.
- [`src/protocol/data-channel.ts`](../src/protocol/data-channel.ts) — wire dispatcher (`errors`/`add_error`/`rm_error` → store).
- [`src/ui/components/errors-badge.ts`](../src/ui/components/errors-badge.ts) — badge (inline + floating flavours).
- [`src/ui/components/errors-popover.ts`](../src/ui/components/errors-popover.ts) — anchored dropdown.
- [`src/ui/components/errors-page.ts`](../src/ui/components/errors-page.ts) — grouped full-screen view.
- [`src/ui/components/error-toast.ts`](../src/ui/components/error-toast.ts) — transient new-fault notification.

## Adding a new code

When the firmware ships a new fault bit, add the label to `CODE_LABELS` in
[`errors-catalog.ts`](../src/protocol/errors-catalog.ts) using the key
`<source>_<lowercase-hex-code>` (no `0x` prefix, no padding) — for example
`300_200` for source 300 bit value 512. New sources go in `SOURCE_LABELS`.

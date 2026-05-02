# BLE Remote Control

The Unitree BLE remote control (e.g. `Unitree-32KC0D`) is a separate device from the robot — a handheld gamepad that streams stick + button state over BLE. The Unitree mobile app pairs with both the remote and the robot, then forwards remote inputs to the robot over WebRTC. This document covers both halves of that path:

1. [Connecting to the remote over BLE](#ble-connection) — name prefix, GATT service, MTU, handshake, notification format, button mapping.
2. [Forwarding inputs to the robot over WebRTC](#webrtc-relay) — DataChannel topic, message format, keys bitmask, RSSI thresholds.

The remote is independent from the robot's BLE provisioning flow: BlueZ setup, adapter selection, and scanning are shared infrastructure documented in [bluetooth-v1-v2.md](bluetooth-v1-v2.md).

## Compatibility

Tested with the BLE remote bundled with Unitree Go2; the same protocol applies to BLE remotes paired with G1 (the remote hardware is identical, only the host robot differs).

## Table of Contents

- [BLE Connection](#ble-connection)
  - [Discovery](#discovery)
  - [Connection Challenges](#connection-challenges)
  - [Connection Flow](#connection-flow)
  - [Handshake](#handshake)
  - [Notification Packet (20 bytes)](#notification-packet-20-bytes)
  - [Button Mapping](#button-mapping)
  - [Physical Layout](#physical-layout)
- [WebRTC Relay](#webrtc-relay)
  - [Data Flow](#data-flow)
  - [WebRTC Message Format](#webrtc-message-format)
  - [Keys Field](#keys-field)
  - [Input Sources](#input-sources)
  - [RSSI Signal Thresholds](#rssi-signal-thresholds)
- [Quick Reference](#quick-reference)

---

## BLE Connection

### Discovery

The remote advertises with a name beginning `Unitree-` (e.g. `Unitree-32KC0D`). It exposes the V1 (FFE0) GATT service — the same UUIDs the robot uses, but with a different handshake and data format. Scanning logic that filters for robots by `Go2_` / `G1_` prefixes must explicitly include `Unitree-` to find the remote.

| Service / characteristic | UUID |
|---|---|
| Service | `0000ffe0-0000-1000-8000-00805f9b34fb` |
| Notify (remote → client) | `0000ffe1-0000-1000-8000-00805f9b34fb` |
| Write (client → remote) | `0000ffe2-0000-1000-8000-00805f9b34fb` |

### Connection Challenges

The remote is a **dual-mode** Bluetooth device (classic BR/EDR + BLE) and advertises with a **public** Bluetooth address. BlueZ's D-Bus API (`Device1.Connect()`) defaults to classic Bluetooth for such devices, which fails with `br-connection-profile-unavailable` because the remote does not expose a classic profile.

**Solution:** Use `gatttool` (via `pygatt`) which forces BLE/LE transport directly, bypassing BlueZ's transport auto-selection.

### Connection Flow

```
1. BLE Scan     -> Find device with name starting with "Unitree" (not Go2_/G1_)
2. LE Connect   -> Force BLE transport (gatttool -t public)
3. Set MTU      -> Request MTU 64 (200ms after connect)
4. Subscribe    -> Enable notifications on FFE1
5. Handshake    -> Write hex-encoded "YS+2" to FFE2
```

### Handshake

The handshake string `"YS+2"` is converted to its hex-character representation:

```
'Y' = 0x59 -> "59"
'S' = 0x53 -> "53"
'+' = 0x2B -> "2b"
'2' = 0x32 -> "32"

Result: b"59532b32" (8 ASCII bytes written to FFE2)
```

This is **not** AES-encrypted — it is sent as raw bytes. Note this differs from the robot handshake (`"unitree"`, AES-encrypted, opcode `0x01`); the remote uses neither encryption nor the V1/V2 framing.

### Notification Packet (20 bytes)

After handshake, the remote streams 20-byte packets at ~20 Hz on the notify characteristic (FFE1):

```
Offset  Size  Type        Field
──────  ────  ──────────  ─────────────────
 0      4     float32 LE  Left Stick X (lx)
 4      4     float32 LE  Right Stick X (rx)
 8      4     float32 LE  Right Stick Y (ry)
12      4     float32 LE  Left Stick Y (ly)
16      1     uint8       Button byte 1
17      1     uint8       Button byte 2
18      1     uint8       Battery (0-100%)
19      1     uint8       RSSI
```

Joystick values are IEEE 754 floats, range approximately -1.0 to 1.0.

### Button Mapping

**Byte 16 — Shoulder & Function:**

| Bit | Button |
|-----|--------|
| 0 | R1 |
| 1 | L1 |
| 2 | Start |
| 3 | Select |
| 4 | R2 |
| 5 | L2 |
| 6 | F1 |
| 7 | F2 |

**Byte 17 — Face & D-Pad:**

| Bit | Button |
|-----|--------|
| 0 | A |
| 1 | B |
| 2 | X |
| 3 | Y |
| 4 | Up |
| 5 | Right |
| 6 | Down |
| 7 | Left |

Check if a button is pressed:
```python
pressed = bool((byte >> bit) & 1)
```

### Physical Layout

```
     [L2] [L1]              [R1] [R2]

    ( Left Stick )        ( Right Stick )

         [Up]                 [Y]
   [Left]    [Right]     [X]     [B]
        [Down]                [A]

  [F1] [Select]          [F2] [Start]
```

---

## WebRTC Relay

The Unitree mobile app relays remote-control BLE data to the robot over WebRTC. This is how the remote actually drives the robot when both are paired through the phone — there is no direct BLE link between remote and robot.

### Data Flow

```
BLE Remote (20-byte notification)
  -> Android BleNotifyCallback
  -> EventBus: AppSendRockerEvent(comma_separated_bytes)
  -> WebRTCFragment.onMessageEvent()
  -> evaluateJavascript("appSendRocker", raw_byte_string)
  -> JS dealRocker() parses bytes
  -> publish("rt/wirelesscontroller", {lx, ly, rx, ry, keys})
  -> WebRTC DataChannel
  -> Robot
```

### WebRTC Message Format

```json
{
  "type": "msg",
  "topic": "rt/wirelesscontroller",
  "data": {
    "lx": 0.0,
    "ly": 0.0,
    "rx": 0.0,
    "ry": 0.0,
    "keys": 0
  }
}
```

### Keys Field

The `keys` field is a uint16 bitmask packing all 16 buttons in order:

```
Bit  0: R1      Bit  8: A
Bit  1: L1      Bit  9: B
Bit  2: Start   Bit 10: X
Bit  3: Select  Bit 11: Y
Bit  4: R2      Bit 12: Up
Bit  5: L2      Bit 13: Right
Bit  6: F1      Bit 14: Down
Bit  7: F2      Bit 15: Left
```

### Input Sources

The same `rt/wirelesscontroller` topic is used by three input sources:

| Source | Bridge Method | Notes |
|---|---|---|
| BLE Remote | `appSendRocker(bytes)` | Raw 20-byte notification forwarded |
| USB/Android Gamepad | `appSendJoystick(json)` | ly and ry are **negated** |
| Virtual Joystick (on-screen) | Direct JS publish | No `keys` field (buttons not applicable) |

### RSSI Signal Thresholds

The remote-status UI in the Unitree app maps the RSSI byte (offset 19 of the BLE notification) to a 0–5 bar indicator:

| RSSI (dBm) | Signal Level |
|---|---|
| >= -70 | Excellent |
| >= -75 | Good |
| >= -83 | Fair |
| >= -90 | Weak |
| < -100 | Very weak |

---

## Quick Reference

| Constant | Value |
|---|---|
| Name prefix | `Unitree-` |
| Service UUID | `0000ffe0-0000-1000-8000-00805f9b34fb` |
| Notify char | `0000ffe1-0000-1000-8000-00805f9b34fb` |
| Write char | `0000ffe2-0000-1000-8000-00805f9b34fb` |
| Address type | Public |
| Transport | LE only (force via `gatttool -t public`) |
| MTU request | 64 (200 ms after connect) |
| Handshake bytes | `"59532b32"` (hex of `"YS+2"`) |
| Handshake encryption | None |
| Notification size | 20 bytes |
| Notification rate | ~20 Hz |
| WebRTC topic | `rt/wirelesscontroller` |
| Keys bitmask | uint16, bits 0–15 = R1,L1,Start,Select,R2,L2,F1,F2,A,B,X,Y,Up,Right,Down,Left |

For the robot-side BLE protocol (provisioning, WiFi, serial number), see [bluetooth-v1-v2.md](bluetooth-v1-v2.md). For the V3 extension on G1 ≥ 1.5.1, see [bluetooth-v3.md](bluetooth-v3.md).

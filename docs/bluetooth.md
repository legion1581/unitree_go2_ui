# Bluetooth Protocol — Unitree Go2

This document describes the BLE protocols used to communicate with the Unitree Go2 robot and the Unitree BLE remote control. Covers service UUIDs, encryption, packet format, handshakes, WiFi configuration, and remote control data.

## Table of Contents

- [Scanning](#scanning)
- [Service UUIDs](#service-uuids)
- [Encryption](#encryption)
- [Packet Format](#packet-format)
- [Robot Connection Flow](#robot-connection-flow)
- [Commands](#commands)
- [WiFi Configuration](#wifi-configuration)
- [V3 Protocol Extension (GCM Key)](#v3-protocol-extension-gcm-key)
- [Remote Control](#remote-control)
- [WebRTC Relay](#webrtc-relay)

---

## Scanning

Robots and remotes are discovered via BLE advertisement.

### Device Name Prefixes

| Prefix | Device |
|--------|--------|
| `Go2_` | Unitree Go2 robot |
| `Unitree` (not `Go2_`) | BLE Remote Control (e.g. `Unitree-32KC0D`) |

### Protocol Detection

The protocol version is determined by which service UUID appears in the BLE advertisement:

| Service UUID | Protocol | Firmware |
|---|---|---|
| `0000ffe0-0000-1000-8000-00805f9b34fb` | Old (FFE0) | Pre-1.1.11 |
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | New (NUS) | 1.1.11+ |

---

## Service UUIDs

### Old Protocol (FFE0)

| UUID | Role |
|---|---|
| `0000ffe0-0000-1000-8000-00805f9b34fb` | Service |
| `0000ffe1-0000-1000-8000-00805f9b34fb` | Notify (robot -> client) |
| `0000ffe2-0000-1000-8000-00805f9b34fb` | Write (client -> robot) |

### New Protocol (Nordic UART Service)

| UUID | Role |
|---|---|
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Service |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / TX (client -> robot) |
| `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify / RX (robot -> client) |

Both protocols use the same encryption, packet format, and command set — only the UUIDs differ.

---

## Encryption

All robot BLE packets (V1/V2) are encrypted with AES-128-CFB before transmission and decrypted on receive.

| Parameter | Value |
|---|---|
| Algorithm | AES-128-CFB |
| Segment Size | 128 bits |
| Key | `df98b715d5c6ed2b25817b6f2554124a` |
| IV | `2841ae97419c2973296a0d4bdfe19a4f` |

```python
from Crypto.Cipher import AES

KEY = bytes.fromhex("df98b715d5c6ed2b25817b6f2554124a")
IV  = bytes.fromhex("2841ae97419c2973296a0d4bdfe19a4f")

def encrypt(data: bytes) -> bytes:
    return AES.new(KEY, AES.MODE_CFB, iv=IV, segment_size=128).encrypt(data)

def decrypt(data: bytes) -> bytes:
    return AES.new(KEY, AES.MODE_CFB, iv=IV, segment_size=128).decrypt(data)
```

> **Note:** V3 protocol packets (magic prefix `0055543235` / "UT25") are sent unencrypted.

---

## Packet Format

### Client -> Robot (Request)

After building the plaintext packet, it is AES-encrypted before writing to the GATT characteristic.

#### Simple Packet

```
[0x52] [length] [instruction] [data...] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Header | 1 | Always `0x52` |
| Length | 1 | `len(data) + 4` (counts header, length, instruction, checksum) |
| Instruction | 1 | Command ID |
| Data | 0-N | Command payload |
| Checksum | 1 | `(-sum(header..data)) & 0xFF` |

#### Chunked Packet

Used when data exceeds the 14-byte chunk limit (SSID, password, handshake).

```
[0x52] [length] [instruction] [chunk_idx] [total_chunks] [data...] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Header | 1 | Always `0x52` |
| Length | 1 | `len(data) + 6` (counts header through data + checksum) |
| Instruction | 1 | Command ID |
| Chunk Index | 1 | 1-based index of this chunk |
| Total Chunks | 1 | Total number of chunks |
| Data | 1-14 | Chunk payload (max `CHUNK_SIZE = 14` bytes) |
| Checksum | 1 | `(-sum(header..data)) & 0xFF` |

### Robot -> Client (Response)

Received as encrypted bytes on the notify characteristic, then AES-decrypted.

```
[0x51] [length] [instruction] [status] [data...] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Header | 1 | Always `0x51` |
| Length | 1 | Payload length |
| Instruction | 1 | Echoed command ID |
| Status | 1 | `0x01` = success |
| Data | 0-N | Response payload |
| Checksum | 1 | `(-sum(header..data)) & 0xFF` |

Chunked responses (e.g. GET_SN) include `chunk_idx` and `total_chunks` after the instruction byte, same as the request format.

---

## Robot Connection Flow

```
1. BLE Scan        -> Find device with name prefix Go2_
2. GATT Connect    -> Connect to the device
3. Detect Protocol -> Check services for NUS or FFE0
4. Subscribe       -> Enable notifications on the notify characteristic
5. Handshake       -> Send chunked packet: instruction=0x01, data="unitree"
6. Verify          -> Response status byte == 0x01 means success
```

### Handshake Detail

The handshake sends the string `"unitree"` (7 bytes) as a chunked packet with `idx=1, total=1`:

```
Plaintext: [0x52] [0x0D] [0x01] [0x01] [0x01] [u] [n] [i] [t] [r] [e] [e] [checksum]
           header  len=13  CMD    idx    total   -------- "unitree" --------
```

This is then AES-encrypted and written to the write characteristic.

---

## Commands

| Command | ID | Format | Description |
|---|---|---|---|
| HANDSHAKE | `0x01` | Chunked | Auth with `"unitree"` |
| GET_SN | `0x02` | Simple (no data) | Request serial number (response is chunked) |
| WIFI_TYPE | `0x03` | Simple | Set WiFi mode: `0x01`=AP, `0x02`=STA |
| WIFI_SSID | `0x04` | Chunked | Send SSID (up to 14 bytes per chunk) |
| WIFI_PWD | `0x05` | Chunked | Send password (up to 14 bytes per chunk) |
| COUNTRY | `0x06` | Simple | Set country code: `[0x01] + "US\x00"` |
| GET_AP_MAC | `0x07` | Simple (no data) | Request AP MAC address |
| DISCONNECT | `0x08` | Simple (no data) | Disconnect BLE |
| HEARTBEAT | `0x0A` | Simple (no data) | Keep-alive |

### Response Parsing

- **GET_SN**: Comes as multiple chunked response packets. Reassemble chunks by index, decode as UTF-8.
- **GET_AP_MAC**: MAC bytes at `response[3:length-1]`, format as `XX:XX:XX:XX:XX:XX`.
- **WIFI_TYPE/SSID/PWD/COUNTRY**: Success if `response[3] == 0x01`.

---

## WiFi Configuration

Full WiFi setup sequence after handshake:

```
1. Set mode     -> WIFI_TYPE (0x03) with 0x01 (AP) or 0x02 (STA)
2. Send SSID    -> WIFI_SSID (0x04) chunked, 14 bytes per chunk, 50ms between
3. Send password -> WIFI_PWD (0x05) chunked, 14 bytes per chunk, 100ms between
4. Set country  -> COUNTRY (0x06) with [0x01] + country_code + \x00
```

Each step waits for a success response before proceeding. The password step has a longer timeout (15s) as the robot applies the WiFi configuration.

> **Security note (CVE-2025-35027):** The robot passes SSID and password to shell scripts via `system()` without sanitization. This command injection vulnerability is present in firmware up to and including 1.1.11.

---

## V3 Protocol Extension (GCM Key)

Firmware 1.1.11+ supports V3 commands that are sent **unencrypted** (no AES-CFB).

### Magic Prefix

```
0x00 0x55 0x54 0x32 0x35  ("UT25")
```

### V3 Commands

| Command | ID | Description |
|---|---|---|
| VERSION | `0xF1` | Request BLE module version |
| GCM_KEY | `0xF2` | Request AES-128-GCM key for WebRTC auth (data2=3) |

### V3 Packet Format

```
[0x00] [0x55] [0x54] [0x32] [0x35] [command] [checksum]
```

### V3 Response Format

```
[0x00] [0x55] [0x54] [0x32] [0x35] [command] [chunk_idx] [total_chunks] [data...] [checksum]
```

### GCM Key

The Go2 returns a raw hex string (32 ASCII chars = 16-byte key). The key is per-device, generated at first boot, and stored persistently. It is used for `data2=3` WebRTC authentication via AES-128-GCM encryption of the SDP nonce.

---

## Remote Control

The Unitree BLE remote control (e.g. `Unitree-32KC0D`) is a dual-mode Bluetooth device (classic BR/EDR + BLE). It uses the old FFE0 service but with a different handshake and data format than the robot.

### Connection Challenges

The remote advertises with a **public** Bluetooth address and supports both BR/EDR and BLE. BlueZ's D-Bus API (`Device1.Connect()`) defaults to classic Bluetooth for such devices, which fails with `br-connection-profile-unavailable`. 

**Solution:** Use `gatttool` (via `pygatt`) which forces BLE/LE transport directly, bypassing BlueZ's transport auto-selection.

### Connection Flow

```
1. BLE Scan     -> Find device with name starting with "Unitree" (not Go2_)
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

This is **not** AES-encrypted — it is sent as raw bytes.

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

The Unitree app relays remote control BLE data to the robot over WebRTC. This is how the remote controls the robot when connected through the phone.

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

### RSSI Signal Thresholds (Remote UI)

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
| AES Key | `df98b715d5c6ed2b25817b6f2554124a` |
| AES IV | `2841ae97419c2973296a0d4bdfe19a4f` |
| Request header | `0x52` |
| Response header | `0x51` |
| Chunk size | 14 bytes |
| Handshake string (robot) | `"unitree"` |
| Handshake string (remote) | `"59532b32"` (hex of `"YS+2"`) |
| V3 magic | `0055543235` (`"UT25"`) |
| WiFi AP mode byte | `0x01` |
| WiFi STA mode byte | `0x02` |
| Success status | `0x01` |

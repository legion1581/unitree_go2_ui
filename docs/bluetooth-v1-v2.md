# Bluetooth Protocol V1 / V2 — Unitree Robots

This document describes the legacy BLE provisioning protocol used to scan, connect, and configure Unitree robots (WiFi setup, serial number, AP MAC).

Related documents:
- [bluetooth-v3.md](bluetooth-v3.md) — V3 extension (`VERSION` 0xF1, `GCM_KEY` 0xF2) introduced on G1 firmware 1.5.1. **Not** available on Go2.
- [remote-control.md](remote-control.md) — BLE remote (`Unitree-*`) protocol and the WebRTC relay that forwards remote inputs to the robot.

## Firmware Compatibility

| Robot | Firmware | Service |
|---|---|---|
| Unitree Go2 | All released versions (`< 1.1.11` uses FFE0, `≥ 1.1.11` uses NUS) | V1 / V2 |
| Unitree G1 | `< 1.5.1` | V1 / V2 |
| Unitree G1 | `≥ 1.5.1` | V1 / V2 + [V3 extension](bluetooth-v3.md) |

V1 and V2 share the same wire format, encryption, and command set. The only difference is the GATT service UUID used to expose the characteristics — see [Service UUIDs](#service-uuids).

## Table of Contents

- [System Requirements](#system-requirements)
- [Scanning](#scanning)
- [Service UUIDs](#service-uuids)
- [Encryption](#encryption)
- [Packet Format](#packet-format)
- [Robot Connection Flow](#robot-connection-flow)
- [Commands](#commands)
- [WiFi Configuration](#wifi-configuration)

---

## System Requirements

### Linux Packages

| Package | Purpose | Install |
|---|---|---|
| `bluez` | BlueZ daemon, `bluetoothctl`, `gatttool`, `hciconfig` | `sudo apt install bluez` |

The `bluez` package provides both the BlueZ D-Bus daemon (`bluetoothd`) used by `bleak` for the robot, and `gatttool` used by `pygatt` for the remote control.

### Python Packages

All listed in `server/requirements.txt`:

```
fastapi>=0.110.0      # REST API
uvicorn>=0.27.0       # ASGI server
bleak>=0.22.0         # BlueZ D-Bus BLE client (used for robot)
pycryptodome>=3.20.0  # AES-128-CFB encryption
pygatt>=4.0.0         # gatttool wrapper (used for remote control)
```

Install with:
```bash
pip install -r server/requirements.txt
```

### User Permissions

On **Ubuntu 22.04** (and some other distros), the default D-Bus policy at `/etc/dbus-1/system.d/bluetooth.conf` already allows any local user to communicate with `org.bluez`, so no group membership is needed.

On **Debian, Fedora, Arch, Ubuntu with hardened D-Bus policies**, add your user to the `bluetooth` group:

```bash
sudo usermod -aG bluetooth $USER
# Log out and back in for group changes to take effect
```

### Required Services

BlueZ daemon must be running:

```bash
sudo systemctl enable --now bluetooth
systemctl is-active bluetooth  # should print "active"
```

### Bluetooth Adapter

Check your HCI adapter(s):

```bash
hciconfig -a
```

If the adapter shows `DOWN` (common for USB dongles after plug-in), bring it up:

```bash
sudo hciconfig hci0 up   # or hci1, etc.
```

The BLE server exposes `/adapters` and `/adapter` endpoints to switch between adapters at runtime.

### What's NOT Required

- **Running as root** — not needed
- **`setcap CAP_NET_RAW` on binaries** — `gatttool` and `hcitool` delegate privileged ops to `bluetoothd` which already runs as root
- **Disabling AppArmor/SELinux** — default policies allow everything needed

### Troubleshooting

| Error | Fix |
|---|---|
| `Operation not permitted` during scan | Ensure `bluetoothd` is running (`systemctl status bluetooth`) |
| `org.bluez.Error.NotReady` | Adapter is DOWN — `sudo hciconfig hciX up` |
| `org.bluez.Error.NotAvailable: br-connection-profile-unavailable` (remote) | Normal for dual-mode remote on BlueZ 5.64; `pygatt` handles this automatically |
| `Could not connect to the system bus` | User not in `bluetooth` group on a distro that requires it |
| Adapter not found | USB dongle not recognized — check `dmesg | tail` for driver errors |

---

## Scanning

Robots and remotes are discovered via BLE advertisement.

### Device Name Prefixes

| Prefix | Device |
|--------|--------|
| `Go2_` | Unitree Go2 robot |
| `G1_`  | Unitree G1 robot |
| `Unitree-` | BLE Remote Control (e.g. `Unitree-32KC0D`) — see [remote-control.md](remote-control.md) |

### Protocol Detection

The protocol variant is determined by which service UUID appears in the BLE advertisement:

| Service UUID | Variant | Firmware |
|---|---|---|
| `0000ffe0-0000-1000-8000-00805f9b34fb` | V1 (FFE0) | Go2 `< 1.1.11`, all G1 |
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | V2 (NUS) | Go2 `≥ 1.1.11` |

---

## Service UUIDs

### V1 (FFE0)

| UUID | Role |
|---|---|
| `0000ffe0-0000-1000-8000-00805f9b34fb` | Service |
| `0000ffe1-0000-1000-8000-00805f9b34fb` | Notify (robot -> client) |
| `0000ffe2-0000-1000-8000-00805f9b34fb` | Write (client -> robot) |

### V2 (Nordic UART Service)

| UUID | Role |
|---|---|
| `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Service |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / TX (client -> robot) |
| `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify / RX (robot -> client) |

Both variants use the same encryption, packet format, and command set — only the UUIDs differ.

---

## Encryption

All robot BLE packets are encrypted with AES-128-CFB before transmission and decrypted on receive.

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

> **Note:** The V3 extension on G1 (firmware ≥ 1.5.1) sends a small set of additional commands **unencrypted** with a different magic prefix. See [bluetooth-v3.md](bluetooth-v3.md). On a V1/V2 connection, frames whose first byte is `0x00` (rather than the encrypted-frame distribution) belong to V3 and must be routed to the V3 handler before AES decryption is attempted.

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
1. BLE Scan        -> Find device with name prefix Go2_ or G1_
2. GATT Connect    -> Connect to the device
3. Detect Protocol -> Check services for NUS (V2) or FFE0 (V1)
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

> **Security note (CVE-2025-35027):** On Go2 firmware up to and including 1.1.11, the robot passes SSID and password to shell scripts via `system()` without sanitization, allowing command injection.

---

## Quick Reference

| Constant | Value |
|---|---|
| AES Key | `df98b715d5c6ed2b25817b6f2554124a` |
| AES IV | `2841ae97419c2973296a0d4bdfe19a4f` |
| Request header | `0x52` |
| Response header | `0x51` |
| Chunk size | 14 bytes |
| Handshake string | `"unitree"` |
| WiFi AP mode byte | `0x01` |
| WiFi STA mode byte | `0x02` |
| Success status | `0x01` |

For the V3 extension (`VERSION` 0xF1, `GCM_KEY` 0xF2 — G1 firmware ≥ 1.5.1 only), see [bluetooth-v3.md](bluetooth-v3.md). For the BLE remote control and the WebRTC relay that forwards its inputs to the robot, see [remote-control.md](remote-control.md).

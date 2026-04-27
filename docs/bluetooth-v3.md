# Bluetooth Protocol V3 — Unitree G1

V3 is a small extension to the V1/V2 BLE protocol introduced on the Unitree G1. It runs over the **same** GATT service and characteristics (FFE0 / FFE1 / FFE2 — see [bluetooth-v1-v2.md § Service UUIDs](bluetooth-v1-v2.md#service-uuids)) and coexists on the same connection: a single notify subscription receives both V1/V2 (encrypted) and V3 (unencrypted) frames, distinguished by their first byte.

V3 currently exposes two read-only commands:

- `VERSION` (`0xF1`) — fetch the BLE module version string.
- `GCM_KEY` (`0xF2`) — fetch the per-device AES-128-GCM key used for WebRTC `data2=3` authentication.

Unlike V1/V2, V3 frames are **not** AES-CFB encrypted. They are framed with a fixed magic prefix that lets receivers tell them apart from V1/V2 ciphertext.

## Firmware Compatibility

| Robot | Firmware | V3 supported |
|---|---|---|
| Unitree G1 | `≥ 1.5.1` | ✅ Yes |
| Unitree G1 | `< 1.5.1` | ❌ No (V1/V2 only) |
| Unitree Go2 | All versions | ❌ No (V3 was never shipped on Go2) |

A client targeting both robot families must:
1. Connect normally per [V1/V2 Connection Flow](bluetooth-v1-v2.md#robot-connection-flow).
2. Send a V3 request and treat a timeout as "V3 not supported" rather than as a failure. The robot silently drops V3 frames it does not recognize.

## Table of Contents

- [Magic Prefix](#magic-prefix)
- [Packet Format](#packet-format)
- [Commands](#commands)
- [GCM Key Usage](#gcm-key-usage)
- [Coexistence With V1/V2](#coexistence-with-v1v2)
- [Quick Reference](#quick-reference)

---

## Magic Prefix

Every V3 frame — request or response — starts with the 5-byte magic:

```
0x00 0x55 0x54 0x32 0x35     ("\0UT25")
```

The leading `0x00` is significant: V1/V2 frames begin with `0x52` (request) or `0x51` (response, after AES-CFB decryption). Any frame whose first byte is `0x00` on the notify characteristic is V3 and must **not** be passed through `AES.decrypt()` — doing so would produce garbage.

## Packet Format

V3 packets are sent as plaintext (no encryption). The checksum is the same scheme as V1/V2: `(-sum(bytes_so_far)) & 0xFF`, computed over every byte of the frame except the checksum itself, including the magic prefix.

### Client → Robot (Request)

```
[0x00] [0x55] [0x54] [0x32] [0x35] [command] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Magic | 5 | Fixed `00 55 54 32 35` |
| Command | 1 | Opcode (`0xF1` = VERSION, `0xF2` = GCM_KEY) |
| Checksum | 1 | `(-sum(magic..command)) & 0xFF` |

Total: **7 bytes**, written unencrypted to the V1 (FFE2) or V2 (NUS TX) write characteristic.

### Robot → Client (Response)

V3 responses are chunked. Each notification carries one chunk of a larger payload:

```
[0x00] [0x55] [0x54] [0x32] [0x35] [command] [chunk_idx] [total_chunks] [data...] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Magic | 5 | Fixed `00 55 54 32 35` |
| Command | 1 | Echoed opcode |
| Chunk Index | 1 | 1-based index of this chunk |
| Total Chunks | 1 | Total number of chunks |
| Data | 0-N | Chunk payload |
| Checksum | 1 | `(-sum(magic..data)) & 0xFF` |

For short responses the robot may emit a single frame with `chunk_idx = total_chunks = 1`.

### Reassembly

Buffer chunks per `command` until `len(received) == total_chunks`, then concatenate in index order. Decode the assembled bytes as UTF-8 and strip trailing `\x00` / whitespace.

```python
buckets: dict[int, dict[int, bytes]] = {}

def on_v3_frame(raw: bytes) -> tuple[int, str] | None:
    if len(raw) < 9 or raw[:5] != b"\x00UT25":
        return None
    if (sum(raw) & 0xFF) != 0:                         # checksum
        return None
    cmd, idx, total, data = raw[5], raw[6], raw[7], raw[8:-1]
    bucket = buckets.setdefault(cmd, {})
    bucket[idx] = data
    if len(bucket) >= total:
        full = b"".join(bucket[i] for i in sorted(bucket)).rstrip(b"\x00").strip()
        del buckets[cmd]
        return cmd, full.decode("utf-8")
    return None
```

## Commands

| Command | ID | Request payload | Response payload |
|---|---|---|---|
| VERSION | `0xF1` | (none) | UTF-8 string — BLE module firmware version |
| GCM_KEY | `0xF2` | (none) | 32-character hex ASCII (16-byte AES-128-GCM key) |

### `0xF1` VERSION

Returns the BLE module version string the robot reports for itself. Useful as a probe: a successful response confirms the robot speaks V3, so a client can decide whether to attempt `0xF2` and whether to enable V3-dependent UI.

### `0xF2` GCM_KEY

Returns a per-device AES-128-GCM key encoded as 32 ASCII hex characters (16 bytes). The key is generated on the robot at first boot and persisted in flash; it is the same on every read for the lifetime of the device.

On the robot's filesystem the key is stored at `/unitree/etc/key/aes_key.bin` (verified against the on-robot `btgatt-server` binary).

## GCM Key Usage

The key returned by `0xF2` is the secret used for `data2=3` WebRTC SDP authentication. The Unitree app derives a session nonce from the SDP offer/answer, encrypts it with this key under AES-128-GCM, and includes the ciphertext + tag in the signaling payload. The robot decrypts and validates the nonce before establishing the WebRTC peer connection.

Without the GCM key:
- WebRTC handshakes against G1 firmware ≥ 1.5.1 will fail at the `data2=3` step.
- Older firmware (G1 `< 1.5.1`, all Go2) does not require this auth and accepts unauthenticated SDP exchanges.

The key is per-device and not user-secret in the strong sense (the robot freely hands it out over BLE to any client that completes the V1/V2 handshake), but it should be cached locally rather than re-fetched on every WebRTC session.

## Coexistence With V1/V2

V3 does **not** replace V1/V2. The standard handshake (`HANDSHAKE`/`0x01` with `"unitree"`) is still required to bring the connection into a usable state, and WiFi configuration / serial number / AP MAC fetches still go through V1/V2. V3 is purely additive.

A correctly-implemented notify handler dispatches per-frame:

```python
def on_notify(raw: bytes) -> None:
    if len(raw) >= 5 and raw[:5] == b"\x00UT25":
        handle_v3(raw)              # plaintext, V3 dispatcher
    else:
        plain = aes_cfb_decrypt(raw)
        if len(plain) >= 4 and plain[0] == 0x51:
            handle_v1_v2(plain)     # standard V1/V2 response
```

Routing V3 frames to the AES decryptor is a frequent porting bug — the decrypted output looks valid (random bytes), no exception is raised, and the framework silently drops the result because the first byte isn't `0x51`.

## Quick Reference

| Constant | Value |
|---|---|
| Magic prefix | `00 55 54 32 35` (`"\0UT25"`) |
| Request length | 7 bytes |
| VERSION opcode | `0xF1` |
| GCM_KEY opcode | `0xF2` |
| Checksum | `(-sum(bytes)) & 0xFF`, includes magic |
| Encryption | None (plaintext) |
| Min firmware | G1 1.5.1 |
| GCM key length | 16 bytes (32 hex chars) |
| GCM key file (on-robot) | `/unitree/etc/key/aes_key.bin` |

For scanning, V1/V2 commands, and WiFi configuration, see [bluetooth-v1-v2.md](bluetooth-v1-v2.md). For the BLE remote control and the WebRTC relay that forwards its inputs to the robot, see [remote-control.md](remote-control.md).

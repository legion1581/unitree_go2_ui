# Bluetooth Protocol V3 — Unitree G1

V3 is a small extension to the V1/V2 BLE protocol introduced on the Unitree G1. It runs over the **same** GATT service and characteristics (FFE0 / FFE1 / FFE2 — see [bluetooth-v1-v2.md § Service UUIDs](bluetooth-v1-v2.md#service-uuids)) and coexists on the same connection: a single notify subscription receives both V1/V2 (encrypted) and V3 (unencrypted) frames, distinguished by their first byte.

V3 introduces two distinct categories of frames on top of V1/V2:

1. **Plaintext probe frames** — `0xF1` (device-ID) and `0xF2` (RSA-wrapped key blob). Magic-prefixed, unencrypted, used before any AES key is established.
2. **AES-128-GCM-wrapped command frames** — every legacy V1/V2 op (`GET_SN`, `GET_AP_MAC`, `WIFI_TYPE`, `WIFI_SSID`, `WIFI_PWD`, `COUNTRY`, …) is now AES-GCM-encrypted with a per-device 16-byte key. The plaintext payload inside the GCM envelope is the same `[0x52][len][op][…][cksum]` shape used on V1/V2, so the inner dispatcher is unchanged once decrypted.

The plaintext probe path:

- `0xF1` — historically named `VERSION` in the apk's enum, but the response carries the **device serial number** along with a small header (BLE module version byte + a flag byte). On G1 ≥ 1.5.1 this is what the apk uses to identify the robot before any GCM-encrypted command exchange — see [F1 Layout](#f1-version--device-id) below.
- `0xF2` — historically named `GCM_KEY`, but the response is **not** a plain AES key — it's a 256-byte RSA-encrypted blob (344 base64 chars) that the cloud server-side decrypts to derive the per-device 16-byte AES-128 key used for WebRTC `data2=3` authentication and for GCM-wrapping V1/V2 BLE commands.

Plaintext F1/F2 frames are not AES-CFB encrypted; they are framed with a fixed magic prefix so receivers can tell them apart from V1/V2 ciphertext. GCM-wrapped command frames have no magic prefix — they are demuxed from V1/V2 ciphertext by attempting GCM-decrypt first when an AES key is loaded.

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
- [GCM Command Frames](#gcm-command-frames)
- [Authenticated Handshake](#authenticated-handshake)
- [WiFi Configuration Flow](#wifi-configuration-flow)
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

The two opcodes use **different** response layouts:

**`0xF1` VERSION** — single, fixed-size frame (not chunked):

```
[0x00] [0x55] [0x54] [0x32] [0x35] [0xF1] [version_byte] [needShowNetSwitch] [cksum]
```

**`0xF2` GCM_KEY** — chunked. Each notification carries one chunk of a larger payload:

```
[0x00] [0x55] [0x54] [0x32] [0x35] [0xF2] [chunk_idx] [total_chunks] [data...] [checksum]
```

| Field | Size | Description |
|---|---|---|
| Magic | 5 | Fixed `00 55 54 32 35` |
| Command | 1 | Echoed opcode |
| Chunk Index | 1 | 1-based index of this chunk |
| Total Chunks | 1 | Total number of chunks |
| Data | 0-N | Chunk payload (ASCII characters of the base64 key) |
| Checksum | 1 | Per-chunk checksum |

> **Checksum note.** Frames are delivered inside fixed-MTU BLE notifications, which often carry padding past the logical frame end. The `(-sum(bytes)) & 0xFF` check therefore fails on real-world traces and the Unitree app skips it — trust the magic prefix and the opcode-specific layout instead.

### Reassembly

Buffer chunks per `command` until `len(received) == total_chunks`, then concatenate in index order. Decode the assembled bytes as UTF-8 and strip trailing `\x00` / whitespace.

```python
buckets: dict[int, dict[int, bytes]] = {}

def on_v3_frame(raw: bytes) -> tuple[int, str] | None:
    if len(raw) < len(MAGIC) + 2 or raw[:5] != b"\x00UT25":
        return None
    cmd = raw[5]
    if cmd == 0xF1:
        return cmd, str(raw[6])               # F1: not chunked
    if len(raw) < len(MAGIC) + 4:
        return None
    idx, total, data = raw[6], raw[7], raw[8:-1]
    bucket = buckets.setdefault(cmd, {})
    bucket[idx] = data
    if total > 0 and len(bucket) >= total:
        full = b"".join(bucket[i] for i in sorted(bucket)).rstrip(b"\x00").strip()
        del buckets[cmd]
        return cmd, full.decode("utf-8")
    return None
```

## Commands

| Command | ID | Request payload | Response payload |
|---|---|---|---|
| VERSION | `0xF1` | (none) | Single frame: `[magic][F1][version_byte][needShowNetSwitch_flag][reserved(4)][sn_len(1)][sn_ascii][cksum]` — **the SN is embedded** length-prefixed at offset 12. Truncated to 7 chars under MTU=23; full 16 chars under MTU=104. Also pushed in response to the V1/V2 SECRET handshake. |
| GCM_KEY | `0xF2` | (none) | 344 ASCII chars of base64 (256 raw bytes, RSA-encrypted), delivered as 4 chunks. Truncated to 11 chars/chunk under MTU=23. |

### `0xF1` VERSION / Device-ID

Despite the name, this command's response carries the **device serial number** along with a small header (BLE module version + a flag byte). It's both a "do you speak V3?" probe *and* the canonical way to identify the connected robot before any AES key is established — the apk's `dogSn` field is set straight from this frame on G1 ≥ 1.5.1.

#### F1 Layout

```
[0..4]  magic        (5)   00 55 54 32 35
[5]     opcode       (1)   F1
[6]     version      (1)   03  ← BLE module version (0x03 = V3)
[7]     flags        (1)   bit 0 = needShowNetSwitch
[8..11] reserved     (4)   00 00 00 00
[12]    sn_len       (1)   length of the SN that follows (typically 0x10 = 16)
[13..]  sn_ascii     (N)   ASCII SN bytes (e.g. "E21D6000PBF9ELG5")
[last]  cksum        (1)   (-sum(prev bytes)) & 0xFF
```

Full size = `13 + sn_len + 1`. For a 16-char SN that's **30 bytes**, which fits comfortably under MTU=104 but is **truncated to 20 bytes (only 7 chars of SN) under default MTU=23**. Negotiate MTU first if you want the full SN out of this frame.

The frame is pushed unsolicited in response to the V1/V2 SECRET handshake — clients don't need to send `build_v3(0xF1)` explicitly to get it.

### `0xF2` GCM_KEY

> **Important: this is misnamed.** What the firmware returns is **not** an
> AES-128-GCM key — it's a **2048-bit RSA-encrypted blob** (256 bytes,
> base64-encoded as 344 chars including `==` padding) that wraps the actual
> per-device key plus device metadata. The cloud's `device/bindExtData`
> endpoint RSA-decrypts it server-side.

The reply is delivered as **4 chunked F2 frames** (`idx=1..4`, `total=4`).
The data carried per chunk depends on the negotiated BLE MTU:

| MTU | Notify size | Data per chunk | Reassembled length |
|---|---|---|---|
| 23 (default) | 20 B | 11 B | 44 chars (truncated) |
| 104 (apk default) | 101 B | 86 B | 344 chars (full) |

**You must negotiate MTU ≥ 32 to get the full payload** — the apk does
`exchange_mtu(104)` immediately after subscribing to notifications. Under
the default MTU=23 each chunk is truncated and the cloud subsequently
fails to RSA-decrypt the input with `"sk decode error"`.

The on-robot key file is `/unitree/etc/key/aes_key.bin` — but it's the
*encrypted* package, not the raw AES-128 key. The 16-byte key the cloud
returns to the client (and stores as `dev.key`) is what's actually used
for `data2=3` SDP authentication and for GCM-wrapping V1/V2 BLE commands.

## GCM Command Frames

Once an AES-128 key is loaded, every V1/V2 command op the firmware accepts (`GET_SN`, `GET_AP_MAC`, `WIFI_TYPE`, `WIFI_SSID`, `WIFI_PWD`, `COUNTRY`, …) is wrapped in an AES-GCM envelope before being written to the V1 (`FFE2`) characteristic. The robot's replies come back through the same channel using the same envelope.

### Envelope Layout

Both directions share one wire format:

```
[nonce_len(1)] [nonce(12)] [tag_len(1)] [tag(16)]
[cipher_len(1)] [ciphertext(N)] [outer_cksum(1)]
```

- `nonce_len` is always `0x0c` (12) and `tag_len` is always `0x10` (16). They are still on the wire because the firmware parses the lengths rather than hard-coding them.
- `outer_cksum` is `(-sum(body)) & 0xFF`, computed over every byte from `nonce_len` through the last ciphertext byte (i.e. excluding the checksum itself).
- `ciphertext` decrypts under `AES.GCM(key, nonce)` to a V1/V2 *inner* frame whose first byte is the request marker (`0x52` from app, `0x51` from robot).

### Inner-Frame Shapes

There are two inner shapes, mirroring V1's simple/chunked split:

```
simple   = [0x52|0x51] [len] [op] [data...] [inner_cksum]
chunked  = [0x52|0x51] [len] [op] [idx] [total] [data...] [inner_cksum]
```

`len` is the inner frame length including the trailing checksum. `inner_cksum` is `(-sum(prev bytes)) & 0xFF`.

### Which Ops Use Which Shape

The V3 firmware is strict about this — sending the wrong shape causes the request to be silently dropped:

| Op | Shape | Notes |
|---|---|---|
| `GET_SN` (`0x02`) | simple | empty data |
| `WIFI_TYPE` (`0x03`) | simple | 1-byte data: `0x01`=AP, `0x02`=STA |
| `WIFI_SSID` (`0x04`) | **chunked** | UTF-8 SSID; fits single chunk under MTU=104 |
| `WIFI_PWD` (`0x05`) | **chunked** | UTF-8 password; fits single chunk under MTU=104 |
| `COUNTRY` (`0x06`) | simple | `<country_utf8> ‖ <open_byte>` — see [WiFi flow](#wifi-configuration-flow) |
| `GET_AP_MAC` (`0x07`) | simple | empty data |
| `GET_TIME_3` (`0x0b`) | simple | handshake init from app, empty data |
| `CHECK_3` (`0x0c`) | simple | handshake reply, 8-byte BE timestamp+1 |

Even for ops where chunking isn't strictly necessary (the data is small and fits in one MTU), the firmware still pattern-matches on the inner-frame shape; SSID and password must use the chunked layout with `idx=1, total=1` or the request is dropped.

## Authenticated Handshake

Before the robot will respond to any GCM-wrapped command, the app must complete a tiny handshake that proves it holds the AES-128 key and is roughly time-synchronised:

1. App writes `GET_TIME_3` (op `0x0b`, simple inner, GCM-wrapped). Empty data payload.
2. Robot replies with `op=0x0b` carrying an **8-byte big-endian uint64 timestamp** (Unix seconds).
3. App writes `CHECK_3` (op `0x0c`, simple inner, GCM-wrapped) with the same timestamp **+1** as 8 BE bytes.
4. Robot replies with `op=0x0c, result=0x01` if the value matches; further GCM ops are now accepted.

The endianness is non-obvious — the apk reads it via `ByteBuffer.getLong()` (BE) but a few BLE wire references suggest little-endian; the firmware accepts BE only.

After this exchange the AES key is "armed" and `GET_SN` / `GET_AP_MAC` / WiFi ops will be answered. The handshake is done once per BLE connection.

## WiFi Configuration Flow

WiFi config is a five-step sequence, all GCM-wrapped:

1. `WIFI_TYPE` (simple, 1-byte data: `0x01`=AP, `0x02`=STA).
2. `WIFI_SSID` (chunked).
3. `WIFI_PWD` (chunked).
4. `COUNTRY` (simple) — payload is `<country_utf8> ‖ <open_byte>` where `open_byte=0x02` opens the AP / kicks the STA join, and `0x01` closes the AP. **This frame is not optional in AP mode** — without it the robot stores the credentials but never brings the AP up. It's also what triggers the actual radio change.
5. **Wait for unsolicited push** of `op=0x08, result=0x01` (the apk calls this `BleResultEvent type="9"`). This is the real success signal — COUNTRY's `0x06` ack only means "config accepted, opening AP / connecting now". Robot sends `op=0x08, result=<non-1>` on failure (e.g. `0x04` for an AP that couldn't start). 40-second timeout in the apk.

Each of steps 1–4 acks with `[0x51][len][op][result][inner_cksum]`. `result==0x01` means accepted, anything else is a per-step rejection.

```
APP  → WIFI_TYPE  (op 0x03) ──► robot  ◄── ack op 0x03 result 0x01
APP  → WIFI_SSID  (op 0x04) ──► robot  ◄── ack op 0x04 result 0x01
APP  → WIFI_PWD   (op 0x05) ──► robot  ◄── ack op 0x05 result 0x01
APP  → COUNTRY    (op 0x06) ──► robot  ◄── ack op 0x06 result 0x01     (config accepted)
                                       ◄── push op 0x08 result 0x01    (AP up / STA joined)
```

## GCM Key Usage

The key returned by `0xF2` is the secret used for `data2=3` WebRTC SDP authentication. The Unitree app derives a session nonce from the SDP offer/answer, encrypts it with this key under AES-128-GCM, and includes the ciphertext + tag in the signaling payload. The robot decrypts and validates the nonce before establishing the WebRTC peer connection.

Without the GCM key:
- WebRTC handshakes against G1 firmware ≥ 1.5.1 will fail at the `data2=3` step.
- Older firmware (G1 `< 1.5.1`, all Go2) does not require this auth and accepts unauthenticated SDP exchanges.

The key is per-device and not user-secret in the strong sense (the robot freely hands it out over BLE to any client that completes the V1/V2 handshake), but it should be cached locally rather than re-fetched on every WebRTC session.

## Coexistence With V1/V2

The V1/V2 `HANDSHAKE` / `0x01` SECRET exchange is still required at connect time to bring the link into a usable state — V3 firmware answers it with an unsolicited F1 frame instead of the legacy AES-CFB reply, but the app must still send it.

After connect, the picture differs by firmware:

- **G1 ≥ 1.5.1.** Plaintext F1/F2 frames flow alongside GCM-wrapped command frames. The legacy V1/V2 AES-CFB path is **not** used for `GET_SN` / `GET_AP_MAC` / WiFi ops on this firmware — those have all moved into the GCM envelope. Sending a V1/V2 AES-CFB request here is silently dropped.
- **G1 < 1.5.1, all Go2.** No V3 at all. `GET_SN` / `GET_AP_MAC` / WiFi flow stay on the V1/V2 AES-CFB path documented in [bluetooth-v1-v2.md](bluetooth-v1-v2.md).

A correctly-implemented notify handler therefore demuxes three classes of inbound frame:

```python
def on_notify(raw: bytes) -> None:
    # 1) V3 plaintext (F1/F2): magic-prefixed, no encryption.
    if len(raw) >= 5 and raw[:5] == b"\x00UT25":
        handle_v3_plaintext(raw)
        return

    # 2) V3 GCM-wrapped command response — try this first when an AES key
    #    is loaded. Returns the inner V1/V2 frame on success.
    if aes_key is not None:
        plain = gcm_decrypt(raw, aes_key)
        if plain is not None:
            handle_v1_v2_inner(plain)
            return

    # 3) Legacy V1/V2 AES-CFB ciphertext.
    plain = aes_cfb_decrypt(raw)
    if len(plain) >= 4 and plain[0] == 0x51:
        handle_v1_v2_inner(plain)
```

Routing V3 plaintext frames to the AES-CFB decryptor is a frequent porting bug — the decrypted output looks valid (random bytes), no exception is raised, and the framework silently drops the result because the first byte isn't `0x51`.

## Quick Reference

### Plaintext probe frames

| Constant | Value |
|---|---|
| Magic prefix | `00 55 54 32 35` (`"\0UT25"`) |
| Request length | 7 bytes |
| VERSION opcode | `0xF1` |
| GCM_KEY opcode | `0xF2` |
| Checksum | `(-sum(bytes)) & 0xFF`, includes magic |
| Encryption | None (plaintext) |

### GCM-wrapped command ops (inner `0x52`/`0x51` frame)

| Op | Name | Inner shape | Notes |
|---|---|---|---|
| `0x02` | GET_SN | simple | empty data |
| `0x03` | WIFI_TYPE | simple | `0x01`=AP, `0x02`=STA |
| `0x04` | WIFI_SSID | chunked | UTF-8 |
| `0x05` | WIFI_PWD | chunked | UTF-8 |
| `0x06` | COUNTRY | simple | `<country_utf8> ‖ <0x02 open / 0x01 close>` |
| `0x07` | GET_AP_MAC | simple | empty data |
| `0x08` | (push) | simple | unsolicited "AP up / STA joined" success — `result=0x01` |
| `0x0b` | GET_TIME_3 | simple | handshake init / robot timestamp reply (8 BE bytes) |
| `0x0c` | CHECK_3 | simple | handshake reply with timestamp+1 (8 BE bytes) |

### Misc

| Constant | Value |
|---|---|
| Min firmware | G1 1.5.1 |
| Min MTU | 32 (negotiate 104 to match the apk) |
| AES key length | 16 bytes (32 hex chars) |
| Per-device AES key file (on-robot) | `/unitree/etc/key/aes_key.bin` (RSA-wrapped, not raw) |
| Cloud key source | `device/bind/list` → `dev.key` (32 hex chars) |

For scanning, V1/V2 commands, and WiFi configuration, see [bluetooth-v1-v2.md](bluetooth-v1-v2.md). For the BLE remote control and the WebRTC relay that forwards its inputs to the robot, see [remote-control.md](remote-control.md).

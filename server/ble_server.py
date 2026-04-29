#!/usr/bin/env python3
"""
BLE Configuration Server for Unitree Go2
Exposes REST API for scanning, connecting, and configuring robots via BLE.
Also supports connecting to the Unitree BLE remote control.
Runs alongside the Vite dev server — proxied through /ble-api/*.
"""

import asyncio
import json
import logging
import secrets
import struct
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from bleak import BleakScanner  # scanning only; connections use pygatt
from Crypto.Cipher import AES
import pygatt

log = logging.getLogger("ble_server")

# ─── BLE Protocol Constants ──────────────────────────────────────────

AES_KEY = bytes.fromhex("df98b715d5c6ed2b25817b6f2554124a")
AES_IV  = bytes.fromhex("2841ae97419c2973296a0d4bdfe19a4f")

OLD_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
OLD_NOTIFY_UUID  = "0000ffe1-0000-1000-8000-00805f9b34fb"
OLD_WRITE_UUID   = "0000ffe2-0000-1000-8000-00805f9b34fb"
NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_UUID      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

DEVICE_PREFIXES = ("Go2_", "G1_", "B2_", "H1_", "X1_")
REMOTE_PREFIX = "Unitree"
CHUNK_SIZE = 14
DEFAULT_ADAPTER = "hci0"
_current_adapter = DEFAULT_ADAPTER

# V3 protocol (G1 firmware 1.5.1+; not supported on Go2) — sent unencrypted
# with this magic prefix. See docs/bluetooth-v3.md.
V3_MAGIC = bytes([0x00, 0x55, 0x54, 0x32, 0x35])  # "\x00UT25"


class Cmd(IntEnum):
    HANDSHAKE  = 0x01
    GET_SN     = 0x02
    WIFI_TYPE  = 0x03
    WIFI_SSID  = 0x04
    WIFI_PWD   = 0x05
    COUNTRY    = 0x06
    GET_AP_MAC = 0x07
    DISCONNECT = 0x08
    # V3 (unencrypted, V3_MAGIC prefix)
    V3_VERSION = 0xF1
    V3_GCM_KEY = 0xF2


# ─── Crypto ───────────────────────────────────────────────────────────

def ble_encrypt(data: bytes) -> bytes:
    return AES.new(AES_KEY, AES.MODE_CFB, iv=AES_IV, segment_size=128).encrypt(data)

def ble_decrypt(data: bytes) -> bytes:
    return AES.new(AES_KEY, AES.MODE_CFB, iv=AES_IV, segment_size=128).decrypt(data)


# ─── Packet Building ─────────────────────────────────────────────────

def build_simple(instruction: int, data: bytes = b"") -> bytes:
    payload = bytes([0x52, len(data) + 4, instruction]) + data
    checksum = (-sum(payload)) & 0xFF
    return ble_encrypt(payload + bytes([checksum]))

def build_chunked(instruction: int, chunk_data: bytes, idx: int = 1, total: int = 1) -> bytes:
    payload = bytes([0x52, len(chunk_data) + 6, instruction, idx, total]) + chunk_data
    checksum = (-sum(payload)) & 0xFF
    return ble_encrypt(payload + bytes([checksum]))

def build_v3(instruction: int) -> bytes:
    """Build a V3 (unencrypted) request: [V3_MAGIC][instruction][checksum]."""
    payload = V3_MAGIC + bytes([instruction])
    checksum = (-sum(payload)) & 0xFF
    return payload + bytes([checksum])


# ─── V3 GCM encryption / decryption (G1 firmware ≥1.5.1) ────────────
#
# Wire format produced by `formatSendData3` and consumed by `parseByte3`
# in the apk's BleUtils3Kt.kt:
#
#   build_gcm_v3(op, data, key) ->
#     [nonce_len(1)] [nonce(12)] [tag_len(1)] [tag(16)]
#     [cipher_len(1)] [ciphertext(N)] [outer_cksum(1)]
#
# where ciphertext = AES-GCM(key, nonce, plaintext) and `plaintext` is the
# usual V1/V2 inner frame: `[0x52][len][op][data][inner_cksum]`.
#
# Decryption reverses this: parse the header, do AES-GCM-decrypt, return
# the plaintext V1/V2 frame for the existing dispatcher to handle.

def build_gcm_v3(op: int, data: bytes, key: bytes) -> bytes:
    """Build a V3 GCM-wrapped command for sending over BLE on G1 ≥ 1.5.1."""
    inner_len = len(data) + 4  # 0x52 + len + op + data + cksum
    inner = bytes([0x52, inner_len, op]) + data
    inner_cksum = (-sum(inner)) & 0xFF
    plaintext = inner + bytes([inner_cksum])

    nonce = secrets.token_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext)

    body = (
        bytes([len(nonce)]) + nonce +
        bytes([len(tag)]) + tag +
        bytes([len(ciphertext)]) + ciphertext
    )
    outer_cksum = (-sum(body)) & 0xFF
    return body + bytes([outer_cksum])


def decrypt_gcm_v3(raw: bytes, key: bytes) -> Optional[bytes]:
    """Reverse of build_gcm_v3. Returns the inner V1/V2 plaintext frame
    (with leading 0x52) on success, None on header / decryption failure."""
    # Minimum: nonce_len(1)+nonce(12)+tag_len(1)+tag(16)+cipher_len(1)+1 byte ciphertext+cksum = 32
    if len(raw) < 32:
        return None
    nonce_len = raw[0]
    if nonce_len != 12 or len(raw) < 1 + nonce_len + 1:
        return None
    nonce = raw[1:1 + nonce_len]

    tag_len = raw[1 + nonce_len]
    if tag_len != 16 or len(raw) < 2 + nonce_len + tag_len + 1:
        return None
    tag_start = 2 + nonce_len
    tag = raw[tag_start:tag_start + tag_len]

    cipher_len_idx = tag_start + tag_len
    cipher_len = raw[cipher_len_idx]
    cipher_start = cipher_len_idx + 1
    if len(raw) < cipher_start + cipher_len:
        return None
    ciphertext = raw[cipher_start:cipher_start + cipher_len]

    try:
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        return cipher.decrypt_and_verify(ciphertext, tag)
    except Exception:
        return None


# ─── BLE Session ──────────────────────────────────────────────────────

class BLESession:
    """Manages a BLE connection to the robot via pygatt (gatttool).
    Migrated from bleak for reliability on dual-mode / public-address adapters."""

    def __init__(self):
        self._adapter: Optional[pygatt.GATTToolBackend] = None
        self._device = None
        self.write_uuid = OLD_WRITE_UUID
        self.notify_uuid = OLD_NOTIFY_UUID
        self.protocol = "unknown"
        self.address = ""
        self._connected = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        self.event = asyncio.Event()
        self.response: Optional[bytes] = None
        self.sn_chunks: dict[int, bytes] = {}
        self.sn_result: Optional[str] = None

        # V3 (unencrypted) response reassembly: cmd -> {chunk_idx: data}
        self.v3_event = asyncio.Event()
        self.v3_chunks: dict[int, dict[int, bytes]] = {}
        self.v3_results: dict[int, str] = {}
        # F1 frames are NOT chunked: [magic][F1][version][needShowNetSwitch][cksum].
        # On G1 ≥1.5.1, the firmware answers the V1/V2 SECRET handshake with one
        # of these instead of an AES-CFB reply, so we record the version byte
        # separately and signal v3_event the same way chunked F2 frames do.
        self.v3_version: Optional[int] = None
        # 16-byte AES-128 key derived from the BLE GCM key (44-char base64) +
        # bound SN by `device/bindExtData`. When set, V3 (G1 ≥1.5.1) frames
        # that aren't magic-prefixed are GCM-decrypted with this key and
        # routed through the V1/V2 dispatcher.
        self.aes_key: Optional[bytes] = None
        # SN bytes extracted from the F1 frame's payload (bytes 12 onward,
        # length-prefixed). Truncated to whatever the BLE MTU allowed —
        # default MTU=23 caps it at the first 7 chars. After we negotiate
        # MTU=104 in `_connect_sync`, expect the full 16-char SN here.
        self.f1_sn_partial: str = ""

    @property
    def connected(self) -> bool:
        return self._connected and self._device is not None

    def _on_notify(self, handle, value):
        """Called from pygatt's background thread — must use call_soon_threadsafe
        to signal the asyncio event."""
        raw = bytes(value)

        # V3 frames (F1/F2) are unencrypted and start with V3_MAGIC.
        if len(raw) >= len(V3_MAGIC) and raw[:len(V3_MAGIC)] == V3_MAGIC:
            self._handle_v3_response(raw)
            return

        # V3 GCM-wrapped responses: G1 ≥ 1.5.1 firmware sends V1/V2-style
        # frames AES-GCM-encrypted with the per-device 16-byte key. Try the
        # GCM decrypt first when an AES key is available; fall back to the
        # legacy V1/V2 AES-CFB path if GCM doesn't apply.
        plain: Optional[bytes] = None
        if self.aes_key is not None and self.v3_version is not None:
            plain = decrypt_gcm_v3(raw, self.aes_key)
            if plain is not None:
                log.info(f"V3 GCM-decrypted {len(raw)}B → {len(plain)}B inner: {plain.hex()}")
            else:
                # Helpful diagnostic: a non-magic notify on V3 firmware that
                # didn't GCM-decode is probably either (a) wrong AES key, or
                # (b) something else entirely. Log the first 32B so the user
                # can tell us what came in.
                log.info(f"V3 GCM decrypt FAILED on {len(raw)}B notify (first 32B: {raw[:32].hex()})")

        if plain is None:
            try:
                plain = ble_decrypt(raw)
            except Exception:
                return

        if len(plain) < 4:
            return

        # V1/V2 frame: response marker 0x51, command-issued frame: 0x52.
        # GCM-decrypted V3 frames carry the 0x52 echo of the V1/V2 inner.
        marker = plain[0]
        if marker not in (0x51, 0x52):
            return

        instruction = plain[2]

        # G1 V3 timestamp request (op 0x0b) — robot pushes this when it
        # wants the app to authenticate by echoing timestamp+1 as CHECK_3
        # (op 0x0c). Without this exchange GET_AP_MAC / GET_SN never fire.
        if instruction == 0x0b and self.aes_key is not None and self._loop:
            self._loop.call_soon_threadsafe(self._reply_check3, plain)
            return

        # SN comes in chunks (V1 path uses chunked frames; V3 GCM path
        # delivers the SN inline in op-0x02 responses).
        if instruction == Cmd.GET_SN and len(plain) >= 6:
            # V3 GCM path: data is a contiguous string at bytes[3 : plain[1]-1].
            if self.aes_key is not None and len(plain) > 4:
                sn_bytes = plain[3:plain[1] - 1]
                self.sn_result = sn_bytes.decode("utf-8", errors="replace").rstrip("\x00").strip()
                log.info(f"V3 GET_SN result: {self.sn_result!r}")
                if self._loop:
                    self._loop.call_soon_threadsafe(self.event.set)
                return
            # Legacy V1 chunked path
            chunk_idx = plain[3]
            total = plain[4]
            chunk_data = plain[5:plain[1] - 1]
            self.sn_chunks[chunk_idx] = chunk_data
            if len(self.sn_chunks) >= total:
                self.sn_result = b"".join(
                    self.sn_chunks[i] for i in sorted(self.sn_chunks)
                ).decode("utf-8").rstrip("\x00")
                self.sn_chunks.clear()
                if self._loop:
                    self._loop.call_soon_threadsafe(self.event.set)
            return

        self.response = plain
        if self._loop:
            self._loop.call_soon_threadsafe(self.event.set)

    def _reply_check3(self, plain: bytes) -> None:
        """Asyncio-loop-side handler for the V3 0x0b timestamp request:
        parse the uint64 timestamp out of the inner frame, add 1, encrypt
        a CHECK_3 (0x0c) reply with the AES key, and write it. This is
        the same handshake step the apk does in BleDataHandler — without
        it the firmware won't issue subsequent GET_AP_MAC / GET_SN."""
        if self.aes_key is None or self._device is None:
            return
        try:
            # plain[1] = total length; data = plain[3 : plain[1]-1]
            data = plain[3:plain[1] - 1]
            if len(data) < 8:
                return
            ts = int.from_bytes(data[:8], "little")
            reply_data = (ts + 1).to_bytes(8, "little")
            pkt = build_gcm_v3(0x0c, reply_data, self.aes_key)
            log.info(f"V3 CHECK_3 reply: ts={ts}+1 ({len(pkt)}B)")
            asyncio.get_event_loop().run_in_executor(None, self._write_sync, pkt)
        except Exception as e:
            log.warning(f"V3 CHECK_3 reply failed: {e}")

    def _on_disconnect(self, event=None):
        log.info("Robot disconnected (pygatt callback)")
        self._connected = False

    async def connect(self, address: str) -> str:
        if self.connected:
            await self.disconnect()

        self.address = address
        self._loop = asyncio.get_event_loop()

        await self._loop.run_in_executor(None, self._connect_sync, address)
        return self.protocol

    def _connect_sync(self, address: str) -> None:
        self._adapter = pygatt.GATTToolBackend(hci_device=_current_adapter)
        # reset_on_start=True would run `sudo systemctl restart bluetooth` and
        # `sudo hciconfig <hci> reset` (pygatt workaround for a legacy gatttool
        # bonding lockup). Skip it so connecting doesn't prompt for a sudo
        # password — re-enable if bonding lockups appear.
        self._adapter.start(reset_on_start=False)
        try:
            self._device = self._adapter.connect(
                address, address_type=pygatt.BLEAddressType.public, timeout=15,
            )
        except Exception as e:
            try: self._adapter.stop()
            except Exception: pass
            self._adapter = None
            raise HTTPException(500, f"Connect failed: {e}")

        # Discover characteristics to detect protocol (FFE0 vs NUS)
        try:
            chars = self._device.discover_characteristics()
            char_uuids = set(str(u).lower() for u in chars.keys())
        except Exception:
            char_uuids = set()

        if NUS_TX_UUID.lower() in char_uuids:
            self.write_uuid = NUS_TX_UUID
            self.notify_uuid = NUS_RX_UUID
            self.protocol = "nus"
        elif OLD_WRITE_UUID.lower() in char_uuids:
            self.write_uuid = OLD_WRITE_UUID
            self.notify_uuid = OLD_NOTIFY_UUID
            self.protocol = "ffe0"
        else:
            # Fall back to old protocol
            self.write_uuid = OLD_WRITE_UUID
            self.notify_uuid = OLD_NOTIFY_UUID
            self.protocol = "ffe0"

        # Subscribe to notifications
        self._device.subscribe(self.notify_uuid, callback=self._on_notify)

        # Negotiate MTU=104 to match the apk. Default MTU=23 limits notify
        # payloads to 20 bytes, which truncates F1 (which embeds the SN at
        # offset 12) and makes V3 GCM frames (>20 bytes wrapped) unusable.
        # pygatt's gatttool backend exposes exchange_mtu(); some firmwares
        # silently ignore it but the call shouldn't error out the connect.
        try:
            self._device.exchange_mtu(104)
            log.info("MTU exchange to 104 succeeded")
        except Exception as e:
            log.info(f"MTU exchange skipped: {e}")

        try:
            self._device.register_disconnect_callback(self._on_disconnect)
        except Exception:
            pass

        self._connected = True

    async def disconnect(self):
        if self._loop is None:
            self._loop = asyncio.get_event_loop()
        await self._loop.run_in_executor(None, self._disconnect_sync)

    def _disconnect_sync(self):
        try:
            if self._device:
                self._device.disconnect()
        except Exception:
            pass
        try:
            if self._adapter:
                self._adapter.stop()
        except Exception:
            pass
        self._device = None
        self._adapter = None
        self._connected = False
        self.address = ""
        self.protocol = "unknown"
        self.response = None
        self.sn_chunks.clear()
        self.sn_result = None
        self.v3_chunks.clear()
        self.v3_results.clear()
        self.v3_version = None
        self.aes_key = None
        self.f1_sn_partial = ""

    def _write_sync(self, packet: bytes) -> None:
        if self._device:
            self._device.char_write(self.write_uuid, packet)

    async def _write(self, packet: bytes) -> None:
        if not self._loop:
            self._loop = asyncio.get_event_loop()
        await self._loop.run_in_executor(None, self._write_sync, packet)

    async def _write_and_wait(self, packet: bytes, timeout: float = 5.0) -> Optional[bytes]:
        self.event.clear()
        self.response = None
        await self._write(packet)
        try:
            await asyncio.wait_for(self.event.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return self.response

    async def _wait_v1_or_v3(self, timeout: float) -> bool:
        """Wait for either a V1/V2 AES-CFB reply (sets `self.event`) or any
        V3 frame (sets `self.v3_event`). Returns True if either fires."""
        v1 = asyncio.create_task(self.event.wait())
        v3 = asyncio.create_task(self.v3_event.wait())
        try:
            done, _ = await asyncio.wait(
                {v1, v3}, timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            return bool(done)
        finally:
            for t in (v1, v3):
                if not t.done():
                    t.cancel()

    def _classify_handshake(self) -> bool:
        """Inspect what arrived during the handshake wait. Returns True if
        a recognized handshake reply was seen. We deliberately don't mutate
        `self.protocol` here — the transport label (ffe0/nus) stays clean,
        and V3 detection is surfaced separately via `/v3/version` so the
        UI doesn't end up with a doubled suffix."""
        if self.response is not None and len(self.response) >= 4 and self.response[2] == int(Cmd.HANDSHAKE):
            return True
        if self.v3_version is not None:
            return True
        return False

    async def handshake(self) -> bool:
        """Send the V1/V2 SECRET handshake. The robot answers with either:
          • A V1/V2 AES-CFB reply (legacy Go2 / G1 < 1.5.1) — bytes are
            [0x51, len, 0x01 (op echo), version, …]; or
          • A V3 F1 (VERSION) frame (G1 ≥ 1.5.1) — magic-prefixed plaintext
            announcing the BLE module version (typically 3).
        If neither arrives, fall back to an explicit V3 VERSION request to
        cover V3-only firmware that ignores legacy SECRET frames."""
        self.event.clear()
        self.v3_event.clear()
        self.response = None
        self.v3_version = None
        self.v3_results.pop(Cmd.V3_VERSION, None)

        await self._write(build_chunked(Cmd.HANDSHAKE, b"unitree", idx=1, total=1))
        if await self._wait_v1_or_v3(5.0) and self._classify_handshake():
            return True

        # Fallback: explicit V3 VERSION probe.
        self.v3_event.clear()
        self.v3_version = None
        await self._write(build_v3(Cmd.V3_VERSION))
        if await self._wait_v1_or_v3(2.0) and self._classify_handshake():
            return True

        return False

    def set_aes_key(self, hex_key: str) -> bool:
        """Install the per-device AES-128 key (32 hex chars) used to GCM-
        decrypt V3 firmware replies. Returns True on success."""
        h = hex_key.strip().lower()
        if not h or len(h) % 2 != 0:
            return False
        try:
            raw = bytes.fromhex(h)
        except ValueError:
            return False
        if len(raw) not in (16, 24, 32):
            return False
        self.aes_key = raw
        log.info(f"V3 AES key set ({len(raw)} bytes)")
        return True

    async def get_serial_number(self) -> Optional[str]:
        """Resolve the SN. Path depends on detected firmware:
          • V1/V2 (Go2 / pre-1.5.1 G1) — AES-CFB GET_SN, chunked reply.
          • V3 (G1 ≥ 1.5.1) — GCM-encrypted GET_SN if we have the AES key,
            otherwise return the SN already harvested from the F1 frame
            payload. We deliberately don't chase the V1/V2 path on V3
            firmware since it always times out and adds 5s of latency.
        """
        self.sn_result = None
        self.sn_chunks.clear()
        self.event.clear()
        is_v3 = self.v3_version is not None

        if is_v3:
            if self.aes_key is not None:
                pkt = build_gcm_v3(Cmd.GET_SN, b"", self.aes_key)
                await self._write(pkt)
                try:
                    await asyncio.wait_for(self.event.wait(), 3.0)
                except asyncio.TimeoutError:
                    pass
                if self.sn_result:
                    return self.sn_result
            # Whether we tried GCM or skipped it, the F1-embedded SN is the
            # fast and correct fallback on V3 firmware.
            return self.f1_sn_partial or None

        # V1/V2 firmware: AES-CFB GET_SN with chunked reply.
        pkt = build_simple(Cmd.GET_SN)
        await self._write(pkt)
        try:
            await asyncio.wait_for(self.event.wait(), 5.0)
        except asyncio.TimeoutError:
            pass
        await asyncio.sleep(0.5)
        return self.sn_result

    async def get_ap_mac(self) -> Optional[str]:
        is_v3 = self.v3_version is not None

        if is_v3:
            if self.aes_key is None:
                # No way to fetch AP MAC on V3 firmware without the per-
                # device AES key — return None fast, don't waste 5s on a
                # V1/V2 GET_AP_MAC the firmware will silently drop.
                return None
            self.event.clear()
            self.response = None
            pkt = build_gcm_v3(Cmd.GET_AP_MAC, b"", self.aes_key)
            await self._write(pkt)
            try:
                await asyncio.wait_for(self.event.wait(), 3.0)
            except asyncio.TimeoutError:
                pass
            resp = self.response
            if resp and len(resp) >= 4 and resp[2] == Cmd.GET_AP_MAC:
                mac_bytes = resp[3:resp[1] - 1]
                if len(mac_bytes) == 6:
                    return ":".join(f"{b:02X}" for b in mac_bytes)
            return None

        pkt = build_simple(Cmd.GET_AP_MAC)
        resp = await self._write_and_wait(pkt)
        if resp and len(resp) > 4:
            mac_bytes = resp[3:resp[1] - 1]
            return ":".join(f"{b:02X}" for b in mac_bytes)
        return None

    def _handle_v3_response(self, raw: bytes):
        """Parse a V3 frame.

        Two layouts share the same magic prefix:
          F1 (VERSION):  [magic(5)] [0xF1] [version] [needShowNetSwitch] …
                         — single-frame; only the version + flag bytes are
                         meaningful, the rest is padding/unused.
          F2 (GCM_KEY):  [magic(5)] [0xF2] [chunk_idx] [total] [data…] [cksum]
                         — chunked; reassemble until idx == total.

        Checksums on V3 frames are not validated: the BLE notification often
        carries padding past the logical frame end (frame size depends on
        negotiated MTU), so a naive `sum % 256 == 0` check fails. The
        Unitree app also skips this check — see BleDataHandler in the APK.
        """
        if len(raw) < len(V3_MAGIC) + 2:
            return

        cmd = raw[5]
        log.debug(f"V3 frame cmd=0x{cmd:02X} len={len(raw)}: {raw.hex()}")

        if cmd == Cmd.V3_VERSION:
            if len(raw) < len(V3_MAGIC) + 3:
                return
            self.v3_version = raw[6]
            self.v3_results[Cmd.V3_VERSION] = str(raw[6])
            log.info(f"V3 F1 frame: {len(raw)}B {raw.hex()}")
            # F1 layout (G1 ≥ 1.5.1):
            #   [0..4] magic | [5] 0xF1 | [6] version | [7] needShowNetSwitch
            #   [8..11] reserved (zeros)              | [12] sn_len
            #   [13..13+sn_len) ASCII SN              | trailing checksum
            # On default MTU=23 the notify is 20 bytes total so we only see
            # the first 7 SN chars. After MTU=104 the full SN fits.
            if len(raw) >= 14:
                sn_len = raw[12]
                if 1 <= sn_len <= 64:
                    sn_bytes = raw[13:13 + sn_len]
                    self.f1_sn_partial = sn_bytes.decode("ascii", errors="replace").rstrip("\x00")
                    log.info(f"V3 F1 SN field (len={sn_len}, got {len(sn_bytes)}B): {self.f1_sn_partial!r}")
            log.info(f"V3 firmware detected (BLE module version {raw[6]})")
            if self._loop:
                self._loop.call_soon_threadsafe(self.v3_event.set)
            return

        if len(raw) < len(V3_MAGIC) + 4:
            return
        idx = raw[6]
        total = raw[7]
        # Match the APK: data is bytes[8 : len-1] (last byte is the chunk
        # checksum). UTF-8 decode tolerates trailing padding via rstrip below.
        data = raw[8:-1]

        bucket = self.v3_chunks.setdefault(cmd, {})
        bucket[idx] = data
        log.info(f"V3 chunk cmd=0x{cmd:02X} idx={idx}/{total} +{len(data)}B → {data.hex()}")

        if total > 0 and len(bucket) >= total:
            assembled = b"".join(bucket[i] for i in sorted(bucket))
            try:
                text = assembled.decode("utf-8", errors="replace").rstrip("\x00").strip()
            except Exception:
                text = assembled.hex()
            self.v3_results[cmd] = text
            log.info(f"V3 reassembled cmd=0x{cmd:02X}: {text!r} ({len(text)} chars)")
            self.v3_chunks.pop(cmd, None)
            if self._loop:
                self._loop.call_soon_threadsafe(self.v3_event.set)

    async def _send_v3(self, cmd: int, timeout: float = 3.0) -> Optional[str]:
        if not self.connected:
            return None
        self.v3_event.clear()
        self.v3_results.pop(cmd, None)
        self.v3_chunks.pop(cmd, None)
        await self._write(build_v3(cmd))
        # Robot may answer slowly when it has to derive/decrypt the key on first call.
        try:
            await asyncio.wait_for(self.v3_event.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return self.v3_results.get(cmd)

    async def get_gcm_key(self) -> Optional[str]:
        """Fetch per-device AES-128-GCM key (32 hex chars) used for WebRTC auth.
        Returns None on V3-unsupported firmware (timeout)."""
        return await self._send_v3(Cmd.V3_GCM_KEY)

    async def get_version(self) -> Optional[str]:
        """Fetch BLE module version string. Returns None on V3-unsupported firmware."""
        return await self._send_v3(Cmd.V3_VERSION)

    async def set_wifi(self, ssid: str, password: str, ap_mode: bool = False, country: str = "US") -> dict:
        results = {}

        mode_byte = 0x01 if ap_mode else 0x02
        resp = await self._write_and_wait(build_simple(Cmd.WIFI_TYPE, bytes([mode_byte])))
        results["mode"] = resp is not None and len(resp) > 3 and resp[3] == 0x01

        ssid_bytes = ssid.encode("utf-8")
        total = (len(ssid_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
        for i in range(total):
            chunk = ssid_bytes[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            pkt = build_chunked(Cmd.WIFI_SSID, chunk, idx=i + 1, total=total)
            if i + 1 < total:
                await self._write(pkt)
                await asyncio.sleep(0.05)
            else:
                resp = await self._write_and_wait(pkt)
                results["ssid"] = resp is not None and len(resp) > 3 and resp[3] == 0x01

        pwd_bytes = password.encode("utf-8")
        total = (len(pwd_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
        for i in range(total):
            chunk = pwd_bytes[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            pkt = build_chunked(Cmd.WIFI_PWD, chunk, idx=i + 1, total=total)
            if i + 1 < total:
                await self._write(pkt)
                await asyncio.sleep(0.1)
            else:
                self.event.clear()
                self.response = None
                await self._write(pkt)
                try:
                    await asyncio.wait_for(self.event.wait(), 15.0)
                    results["password"] = self.response is not None and len(self.response) > 3 and self.response[3] == 0x01
                except asyncio.TimeoutError:
                    results["password"] = False

        country_data = bytes([0x01]) + country.encode("utf-8") + b"\x00"
        resp = await self._write_and_wait(build_simple(Cmd.COUNTRY, country_data))
        results["country"] = resp is not None and len(resp) > 3 and resp[3] == 0x01

        return results


# ─── Remote Control Session ──────────────────────────────────────────

REMOTE_BUTTON_NAMES = [
    "R1", "L1", "Start", "Select", "R2", "L2", "F1", "F2",
    "A", "B", "X", "Y", "Up", "Right", "Down", "Left",
]


class RemoteSession:
    """Manages a BLE connection to a Unitree remote control.
    Uses pygatt (gatttool) instead of bleak because the remote is a dual-mode
    device (BR/EDR + BLE) and bleak's BlueZ D-Bus backend tries classic
    Bluetooth for public-address dual-mode devices, which fails.
    """

    # If no notification in this many seconds -> consider remote disconnected
    STALE_TIMEOUT = 2.0

    def __init__(self):
        self._adapter: Optional[pygatt.GATTToolBackend] = None
        self._device = None
        self.address = ""
        self.name = ""
        self.latest_state: Optional[dict] = None
        self._connected = False
        self._last_notify_time = 0.0
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    @property
    def connected(self) -> bool:
        if not self._connected or self._device is None:
            return False
        # Stale if no notifications for too long (remote powered off / out of range)
        if self._last_notify_time > 0 and (time.monotonic() - self._last_notify_time) > self.STALE_TIMEOUT:
            return False
        return True

    def _on_notify(self, handle, value):
        raw = bytes(value)
        if len(raw) < 20:
            return
        self._last_notify_time = time.monotonic()
        lx = round(struct.unpack_from("<f", raw, 0)[0], 2)
        rx = round(struct.unpack_from("<f", raw, 4)[0], 2)
        ry = round(struct.unpack_from("<f", raw, 8)[0], 2)
        ly = round(struct.unpack_from("<f", raw, 12)[0], 2)
        btn1 = raw[16]
        btn2 = raw[17]
        battery = raw[18]
        rssi_byte = raw[19]

        buttons = {}
        for i, bname in enumerate(REMOTE_BUTTON_NAMES):
            byte = btn1 if i < 8 else btn2
            bit = i if i < 8 else i - 8
            buttons[bname] = bool((byte >> bit) & 1)

        self.latest_state = {
            "lx": lx, "ly": ly, "rx": rx, "ry": ry,
            "buttons": buttons,
            "battery": battery,
            "rssi": rssi_byte if rssi_byte < 128 else rssi_byte - 256,
        }
        # Broadcast to WebSocket subscribers (thread-safe marshaling to asyncio loop)
        if self._loop:
            state = self.latest_state
            self._loop.call_soon_threadsafe(
                lambda: asyncio.create_task(_broadcast_topic(TOPIC_REMOTE_STATE, state))
            )

    async def connect(self, address: str) -> None:
        if self.connected:
            await self.disconnect()

        self.address = address
        self._loop = asyncio.get_event_loop()

        # Resolve name from scan cache
        cached = _scanned_devices.get(address)
        self.name = (cached.name if cached and hasattr(cached, 'name') else "") or ""

        # pygatt is synchronous — run in executor
        await self._loop.run_in_executor(None, self._connect_sync, address)

    def _connect_sync(self, address: str) -> None:
        import subprocess
        import time as _t

        last_err: Optional[Exception] = None
        # gatttool often times out on the first attempt due to adapter contention or
        # stale BlueZ state. Retry up to 3 times with full cleanup between tries.
        for attempt in range(3):
            # Clean up any stale device state in BlueZ before each try
            try:
                subprocess.run(
                    ["bluetoothctl", "remove", address],
                    capture_output=True, timeout=3, check=False,
                )
            except Exception:
                pass

            self._adapter = pygatt.GATTToolBackend(hci_device=_current_adapter)
            # See BLESession._connect_sync above — skip the sudo-requiring reset.
            self._adapter.start(reset_on_start=False)

            try:
                self._device = self._adapter.connect(
                    address, address_type=pygatt.BLEAddressType.public, timeout=15,
                )
                last_err = None
                break
            except Exception as e:
                last_err = e
                log.info(f"Remote connect attempt {attempt + 1} failed: {e}")
                try: self._adapter.stop()
                except Exception: pass
                self._adapter = None
                _t.sleep(1.0)  # let BlueZ settle before retry

        if last_err is not None:
            raise HTTPException(500, f"Remote connect failed after retries: {last_err}")

        # Handshake — write-without-response (matches APK; avoids NotificationTimeout
        # if the device doesn't ACK within the write window)
        handshake = "".join(f"{ord(c):x}" for c in "YS+2").encode("utf-8")
        try:
            self._device.char_write(OLD_WRITE_UUID, handshake, wait_for_response=False)
        except TypeError:
            # Older pygatt without wait_for_response kwarg
            self._device.char_write(OLD_WRITE_UUID, handshake)
        except Exception as e:
            log.warning(f"Handshake write failed (continuing): {e}")

        # Subscribe to notifications
        self._device.subscribe(OLD_NOTIFY_UUID, callback=self._on_notify)

        # Register disconnect callback (fires when pygatt detects GATT disconnect)
        try:
            self._device.register_disconnect_callback(self._on_disconnect)
        except Exception:
            pass  # older pygatt versions may not support this

        self._last_notify_time = time.monotonic()  # grace period before staleness check
        self._connected = True

    def _on_disconnect(self, event=None):
        """Called by pygatt when the GATT link drops."""
        log.info("Remote disconnected (pygatt callback)")
        self._connected = False
        self.latest_state = None

    async def disconnect(self):
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._disconnect_sync)

    def _disconnect_sync(self):
        try:
            if self._device:
                self._device.disconnect()
        except Exception:
            pass
        try:
            if self._adapter:
                self._adapter.stop()
        except Exception:
            pass
        self._device = None
        self._adapter = None
        self._connected = False
        self.address = ""
        self.name = ""
        self.latest_state = None


# ─── Singleton sessions & device cache ───────────────────────────────

session = BLESession()
remote_session = RemoteSession()
_scanned_devices: dict[str, object] = {}  # address -> BLEDevice from last scan


# ─── FastAPI App ──────────────────────────────────────────────────────

# Single-WebSocket pub/sub registry: each WS carries its own set of subscribed topics
# in a dict mounted on the connection.
TOPIC_STATUS = "status"
TOPIC_ADAPTERS = "adapters"
TOPIC_REMOTE_STATE = "remote_state"

_ws_clients: set[WebSocket] = set()  # all connected WS clients


def _subs_of(ws: WebSocket) -> set:
    """Return the set of topics this WS is subscribed to (lazy-init)."""
    subs = getattr(ws, "_bt_subs", None)
    if subs is None:
        subs = set()
        setattr(ws, "_bt_subs", subs)
    return subs


async def _broadcast_topic(topic: str, data: dict) -> None:
    """Send an event to every WS subscribed to `topic`."""
    if not _ws_clients:
        return
    payload = {"type": topic, "data": data}
    dead: list[WebSocket] = []
    for ws in list(_ws_clients):
        if topic not in _subs_of(ws):
            continue
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


def _snapshot_status() -> dict:
    return {
        "robot": {
            "connected": session.connected,
            "address": session.address,
            "protocol": session.protocol,
        },
        "remote": {
            "connected": remote_session.connected,
            "address": remote_session.address,
            "name": remote_session.name,
        },
    }


def _list_adapters_sync() -> dict:
    """Parse `hciconfig -a`. Each adapter block looks like:

        hci1:  Type: Primary  Bus: USB
            BD Address: 68:8F:C9:40:2E:18  ACL MTU: 1021:9  SCO MTU: 255:4
            UP RUNNING            <-- status line (may be absent -> adapter is DOWN)
            ...
            Manufacturer: not assigned (2875)
    """
    import subprocess
    adapters = []
    try:
        out = subprocess.check_output(["hciconfig", "-a"], text=True, timeout=5)
        current = None
        for line in out.splitlines():
            if line and not line[0].isspace() and ":" in line:
                name = line.split(":")[0].strip()
                current = {"name": name, "address": "", "up": False, "type": ""}
                adapters.append(current)
            elif current and "BD Address:" in line:
                current["address"] = line.split("BD Address:")[1].split()[0].strip()
            elif current and "UP" in line.split() and "RUNNING" in line.split():
                # Status line appears on its own, e.g. "\tUP RUNNING PSCAN"
                current["up"] = True
            elif current and "Manufacturer:" in line:
                current["type"] = line.split("Manufacturer:")[1].strip()
    except Exception:
        pass
    return {"adapters": adapters, "current": _current_adapter}


async def _status_monitor():
    """Push status updates on change + ~5s heartbeat; also tear down stale remotes."""
    last_snapshot: Optional[dict] = None
    heartbeat_counter = 0
    while True:
        try:
            await asyncio.sleep(0.5)
            if remote_session._connected and not remote_session.connected:
                log.info("Remote session stale — tearing down (monitor)")
                await remote_session.disconnect()

            snap = _snapshot_status()
            heartbeat_counter += 1
            if snap != last_snapshot or heartbeat_counter >= 10:
                await _broadcast_topic(TOPIC_STATUS, snap)
                last_snapshot = snap
                heartbeat_counter = 0
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.warning(f"Status monitor error: {e}")


async def _adapter_monitor():
    """Push adapter list updates on change."""
    last_snapshot: Optional[dict] = None
    while True:
        try:
            await asyncio.sleep(2.0)
            loop = asyncio.get_event_loop()
            snap = await loop.run_in_executor(None, _list_adapters_sync)
            if snap != last_snapshot:
                await _broadcast_topic(TOPIC_ADAPTERS, snap)
                last_snapshot = snap
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.warning(f"Adapter monitor error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    status_task = asyncio.create_task(_status_monitor())
    adapter_task = asyncio.create_task(_adapter_monitor())
    yield
    status_task.cancel()
    adapter_task.cancel()
    if session.connected:
        await session.disconnect()
    if remote_session.connected:
        await remote_session.disconnect()

app = FastAPI(title="Go2 BLE Server", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ─── Models ───────────────────────────────────────────────────────────

class WifiRequest(BaseModel):
    ssid: str
    password: str
    ap_mode: bool = False
    country: str = "US"


# ─── Routes ───────────────────────────────────────────────────────────

@app.get("/adapters")
async def list_adapters():
    """List available HCI Bluetooth adapters."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _list_adapters_sync)




@app.post("/adapter")
async def set_adapter(name: str):
    """Switch the active BLE adapter."""
    global _current_adapter
    if session.connected:
        await session.disconnect()
    _current_adapter = name
    return {"current": _current_adapter}


@app.get("/scan")
async def scan(timeout: float = 10.0):
    global _scanned_devices
    try:
        devices = await BleakScanner.discover(
            timeout=timeout, return_adv=True, scanning_mode="active",
            bluez={"adapter": _current_adapter},
        )
    except Exception as e:
        # BlueZ can raise "No discovery started" if pygatt/bluetoothctl disturbed the adapter
        # mid-flight. Retry once with a fresh scanner instance.
        log.info(f"Scan failed ({e}); retrying once")
        await asyncio.sleep(0.5)
        try:
            devices = await BleakScanner.discover(
                timeout=timeout, return_adv=True, scanning_mode="active",
                bluez={"adapter": _current_adapter},
            )
        except Exception as e2:
            raise HTTPException(500, f"Scan failed: {e2}")

    robots = []
    remotes = []
    _scanned_devices.clear()
    for dev, adv in devices.values():
        name = dev.name or getattr(adv, 'local_name', None) or ""
        _scanned_devices[dev.address] = dev  # cache BLEDevice for connect
        if name.startswith(DEVICE_PREFIXES):
            adv_uuids = [str(u).lower() for u in (adv.service_uuids or [])]
            proto = "nus" if NUS_SERVICE_UUID.lower() in adv_uuids else "ffe0" if OLD_SERVICE_UUID.lower() in adv_uuids else "unknown"
            robots.append({
                "name": name,
                "address": dev.address,
                "rssi": adv.rssi if hasattr(adv, "rssi") else None,
                "protocol": proto,
            })
        elif name.startswith(REMOTE_PREFIX) and not name.startswith(DEVICE_PREFIXES):
            remotes.append({
                "name": name,
                "address": dev.address,
                "rssi": adv.rssi if hasattr(adv, "rssi") else None,
            })
    return {"robots": robots, "remotes": remotes}


@app.get("/status")
async def status():
    return {
        "connected": session.connected,
        "address": session.address,
        "protocol": session.protocol,
    }




@app.post("/connect")
async def connect(address: str):
    try:
        proto = await session.connect(address)
        ok = await session.handshake()
        if not ok:
            await session.disconnect()
            raise HTTPException(400, "Handshake failed")
        return {"connected": True, "protocol": proto, "address": address}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/disconnect")
async def disconnect():
    await session.disconnect()
    return {"connected": False}


@app.get("/info")
async def info():
    if not session.connected:
        raise HTTPException(400, "Not connected")
    sn = await session.get_serial_number()
    mac = await session.get_ap_mac()
    return {
        "serial_number": sn,
        "ap_mac": mac,
        "protocol": session.protocol,
        "address": session.address,
        # Partial SN harvested from the F1 frame's payload (truncated by
        # MTU=23 if exchange_mtu didn't take). Useful as a hint when
        # `serial_number` came back null because we don't have the AES key
        # yet to GCM-decrypt the GET_SN reply.
        "f1_sn_partial": session.f1_sn_partial,
    }


@app.post("/v3/aes-key")
async def v3_set_aes_key(key: str):
    """Install the per-device AES-128 key (32 hex chars) used to decrypt
    V3 (G1 ≥ 1.5.1) GCM-wrapped BLE frames. Once set, subsequent /info
    calls fetch SN / AP MAC via GCM-encrypted GET_SN / GET_AP_MAC; the
    backend also auto-replies to the firmware's 0x0b timestamp probe with
    a CHECK_3 (0x0c) so the V3 command chain unblocks."""
    if not session.connected:
        raise HTTPException(400, "Not connected")
    if not session.set_aes_key(key):
        raise HTTPException(400, "Invalid AES key (expected 32/48/64 hex chars)")
    return {"ok": True, "key_bytes": len(session.aes_key) if session.aes_key else 0}


@app.get("/v3/gcm-key")
async def v3_gcm_key():
    """Fetch the per-device AES-128-GCM key (32 hex chars / 16 bytes) used for
    WebRTC `data2=3` authentication. Requires G1 firmware 1.5.1+ (V3 protocol);
    not supported on Go2. Returns `{key: null, supported: false}` on
    unsupported firmware (timeout)."""
    if not session.connected:
        raise HTTPException(400, "Not connected")
    key = await session.get_gcm_key()
    return {"key": key, "supported": key is not None}


@app.get("/v3/version")
async def v3_version():
    """Fetch the BLE module version string. Returns `{version: null, supported: false}`
    on firmware that doesn't speak V3."""
    if not session.connected:
        raise HTTPException(400, "Not connected")
    version = await session.get_version()
    return {"version": version, "supported": version is not None}


@app.post("/wifi")
async def set_wifi(req: WifiRequest):
    if not session.connected:
        raise HTTPException(400, "Not connected")
    results = await session.set_wifi(req.ssid, req.password, req.ap_mode, req.country)
    success = all(results.values())
    return {"success": success, "details": results}


# ─── Remote Control Routes ───────────────────────────────────────────

@app.get("/remote/status")
async def remote_status():
    # If session is stale (no notifications received in 3s) clean it up
    if remote_session._connected and not remote_session.connected:
        log.info("Remote session stale — tearing down")
        await remote_session.disconnect()
    return {
        "connected": remote_session.connected,
        "address": remote_session.address,
        "name": remote_session.name,
    }


@app.post("/remote/connect")
async def remote_connect(address: str):
    try:
        await remote_session.connect(address)
        return {"connected": True, "address": address, "name": remote_session.name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/remote/disconnect")
async def remote_disconnect():
    await remote_session.disconnect()
    return {"connected": False}


@app.get("/remote/state")
async def remote_state():
    if not remote_session.connected:
        raise HTTPException(400, "Remote not connected")
    return remote_session.latest_state or {
        "lx": 0, "ly": 0, "rx": 0, "ry": 0,
        "buttons": {n: False for n in REMOTE_BUTTON_NAMES},
        "battery": 0, "rssi": 0,
    }


@app.websocket("/ws")
async def unified_ws(ws: WebSocket):
    """Single WebSocket for all BLE backend events.

    Protocol:
      Client -> Server: {"type": "subscribe" | "unsubscribe", "topic": "status" | "adapters" | "remote_state"}
      Server -> Client: {"type": <topic>, "data": <payload>}
    """
    await ws.accept()
    _ws_clients.add(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype = msg.get("type")
            topic = msg.get("topic")
            if mtype == "subscribe" and topic in (TOPIC_STATUS, TOPIC_ADAPTERS, TOPIC_REMOTE_STATE):
                _subs_of(ws).add(topic)
                # Push an immediate snapshot so the client sees state right away
                if topic == TOPIC_STATUS:
                    await ws.send_json({"type": topic, "data": _snapshot_status()})
                elif topic == TOPIC_ADAPTERS:
                    loop = asyncio.get_event_loop()
                    snap = await loop.run_in_executor(None, _list_adapters_sync)
                    await ws.send_json({"type": topic, "data": snap})
                elif topic == TOPIC_REMOTE_STATE and remote_session.latest_state:
                    await ws.send_json({"type": topic, "data": remote_session.latest_state})
            elif mtype == "unsubscribe" and topic:
                _subs_of(ws).discard(topic)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning(f"WS error: {e}")
    finally:
        _ws_clients.discard(ws)


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    # Quiet pygatt's per-notification INFO spam (one line per packet at 20 Hz)
    logging.getLogger("pygatt").setLevel(logging.WARNING)
    logging.getLogger("pygatt.backends.gatttool.gatttool").setLevel(logging.WARNING)
    uvicorn.run(app, host="0.0.0.0", port=5051)

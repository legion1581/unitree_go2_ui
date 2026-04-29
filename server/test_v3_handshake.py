#!/usr/bin/env python3
"""
Standalone V3 BLE handshake test against G1_07922.

Walks through the full G1 ≥ 1.5.1 BLE flow with verbose logging at every
step so we can pinpoint exactly where the chain breaks:

  1. Connect via pygatt (gatttool backend), exchange MTU=104, subscribe.
  2. Send V1/V2 SECRET ("unitree") AES-CFB encrypted → expect F1 reply
     with the SN length-prefixed in the payload.
  3. Send F2 request → reassemble 4 chunks → 256-byte RSA-encrypted
     extData blob.
  4. Install the user-provided AES-128 key.
  5. Send GET_TIME_3 (op 0x0b) GCM-encrypted → robot replies with a
     uint64 timestamp.
  6. Echo CHECK_3 (op 0x0c) with timestamp+1 GCM-encrypted.
  7. Send GET_AP_MAC (op 0x07) GCM-encrypted → expect ack.
  8. Send GET_SN (op 0x02) GCM-encrypted → expect SN echo.

Usage:
    python3 test_v3_handshake.py [BLE_ADDR] [AES_KEY_HEX]

Defaults to FC:23:CD:99:67:46 + 6c5123186d17a3fc5e7c96e824df8890.

Stop the production BLE server (`uvicorn ble_server:app`) before running
— pygatt holds the adapter exclusively.
"""

import asyncio
import secrets
import sys
import threading
import time
from typing import Optional

import pygatt
from Crypto.Cipher import AES

# ─── Constants (mirror ble_server.py) ────────────────────────────────

V3_MAGIC = bytes([0x00, 0x55, 0x54, 0x32, 0x35])  # b"\x00UT25"
AES_KEY_V12 = bytes.fromhex("df98b715d5c6ed2b25817b6f2554124a")
AES_IV_V12  = bytes.fromhex("2841ae97419c2973296a0d4bdfe19a4f")

OLD_NOTIFY_UUID  = "0000ffe1-0000-1000-8000-00805f9b34fb"
OLD_WRITE_UUID   = "0000ffe2-0000-1000-8000-00805f9b34fb"

# ─── V1/V2 + V3 frame builders ───────────────────────────────────────

def aes_cfb_enc(data: bytes) -> bytes:
    return AES.new(AES_KEY_V12, AES.MODE_CFB, iv=AES_IV_V12, segment_size=128).encrypt(data)

def aes_cfb_dec(data: bytes) -> bytes:
    return AES.new(AES_KEY_V12, AES.MODE_CFB, iv=AES_IV_V12, segment_size=128).decrypt(data)

def build_chunked_v12(op: int, data: bytes, idx: int = 1, total: int = 1) -> bytes:
    payload = bytes([0x52, len(data) + 6, op, idx, total]) + data
    return aes_cfb_enc(payload + bytes([(-sum(payload)) & 0xFF]))

def build_v3_plain(op: int) -> bytes:
    payload = V3_MAGIC + bytes([op])
    return payload + bytes([(-sum(payload)) & 0xFF])

def build_gcm_v3(op: int, data: bytes, key: bytes) -> bytes:
    inner_len = len(data) + 4
    inner = bytes([0x52, inner_len, op]) + data
    inner_cksum = (-sum(inner)) & 0xFF
    plaintext = inner + bytes([inner_cksum])

    nonce = secrets.token_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext)

    body = (bytes([len(nonce)]) + nonce +
            bytes([len(tag)]) + tag +
            bytes([len(ciphertext)]) + ciphertext)
    return body + bytes([(-sum(body)) & 0xFF])

def decrypt_gcm_v3(raw: bytes, key: bytes) -> Optional[bytes]:
    if len(raw) < 32: return None
    if raw[0] != 12: return None
    nonce = raw[1:13]
    if raw[13] != 16: return None
    tag = raw[14:30]
    cipher_len = raw[30]
    if len(raw) < 31 + cipher_len: return None
    ciphertext = raw[31:31 + cipher_len]
    try:
        return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ciphertext, tag)
    except Exception as e:
        print(f"      GCM decrypt failed: {e}")
        return None

# ─── Test harness ────────────────────────────────────────────────────

class Tester:
    def __init__(self, addr: str, aes_key_hex: str):
        self.addr = addr
        self.aes_key = bytes.fromhex(aes_key_hex)
        self.adapter: Optional[pygatt.GATTToolBackend] = None
        self.device = None
        # Inbound notify queue (raw bytes).
        self.inbox: list[bytes] = []
        self.lock = threading.Lock()
        # Latched results.
        self.f1_sn: str = ""
        self.f2_chunks: dict[int, bytes] = {}
        self.f2_full: str = ""

    def log(self, msg: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    def _on_notify(self, handle, value):
        raw = bytes(value)
        with self.lock:
            self.inbox.append(raw)
        self.log(f"    ← notify {len(raw)}B  {raw.hex()}")

    def wait_for(self, predicate, timeout: float = 5.0):
        """Poll inbox until predicate(raw) returns truthy or timeout."""
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            with self.lock:
                pkts = self.inbox[seen:]
                seen = len(self.inbox)
            for raw in pkts:
                got = predicate(raw)
                if got:
                    return got
            time.sleep(0.05)
        return None

    def connect(self) -> bool:
        self.log(f"Connecting to {self.addr}…")
        self.adapter = pygatt.GATTToolBackend(hci_device="hci0")
        self.adapter.start(reset_on_start=False)
        try:
            self.device = self.adapter.connect(
                self.addr, address_type=pygatt.BLEAddressType.public, timeout=15,
            )
        except Exception as e:
            self.log(f"  ✗ connect failed: {e}")
            return False
        self.log("  ✓ connected")

        try:
            self.device.exchange_mtu(104)
            self.log("  ✓ MTU=104 negotiated")
        except Exception as e:
            self.log(f"  ! MTU exchange skipped: {e}")

        self.device.subscribe(OLD_NOTIFY_UUID, callback=self._on_notify)
        self.log("  ✓ subscribed to FFE1 notifications")
        return True

    def step_secret(self) -> bool:
        self.log("Step 1: V1/V2 SECRET 'unitree' (triggers F1 reply)")
        pkt = build_chunked_v12(0x01, b"unitree")
        self.log(f"    → write {len(pkt)}B (AES-CFB) {pkt.hex()}")
        self.device.char_write(OLD_WRITE_UUID, pkt)

        def is_f1(raw: bytes) -> Optional[bytes]:
            return raw if len(raw) >= 9 and raw[:5] == V3_MAGIC and raw[5] == 0xF1 else None
        f1 = self.wait_for(is_f1, timeout=5.0)
        if not f1:
            self.log("  ✗ no F1 reply")
            return False

        # Parse F1: [magic(5)][F1][version][flag][reserved(4)][sn_len][sn_ascii…]
        if len(f1) >= 14:
            sn_len = f1[12]
            sn_bytes = f1[13:13 + sn_len]
            self.f1_sn = sn_bytes.decode("ascii", errors="replace").rstrip("\x00")
            self.log(f"  ✓ F1: version={f1[6]} flag={f1[7]:02x} sn_len={sn_len} sn={self.f1_sn!r}")
        else:
            self.log(f"  ! F1 too short ({len(f1)}B): {f1.hex()}")
        return True

    def step_fetch_extdata(self) -> bool:
        self.log("Step 2: F2 GCM-key request → 4-chunk RSA extData blob")
        pkt = build_v3_plain(0xF2)
        self.log(f"    → write {len(pkt)}B {pkt.hex()}")
        self.device.char_write(OLD_WRITE_UUID, pkt)

        # Each F2 chunk: [magic(5)][F2][idx][total][data][cksum]
        def assemble(raw: bytes) -> Optional[str]:
            if len(raw) < 8 or raw[:5] != V3_MAGIC or raw[5] != 0xF2:
                return None
            idx, total = raw[6], raw[7]
            data = raw[8:-1]
            self.f2_chunks[idx] = data
            if total > 0 and len(self.f2_chunks) >= total:
                joined = b"".join(self.f2_chunks[i] for i in sorted(self.f2_chunks))
                return joined.decode("utf-8", errors="replace").strip()
            return None

        full = self.wait_for(assemble, timeout=8.0)
        if not full:
            self.log("  ✗ F2 reassembly failed")
            return False
        self.f2_full = full
        self.log(f"  ✓ extData ({len(full)} chars): {full[:40]}…")
        return True

    def step_handshake(self) -> bool:
        self.log(f"Step 3: V3 GCM handshake — GET_TIME_3 (0x0b) with {self.aes_key.hex()}")
        pkt = build_gcm_v3(0x0b, b"", self.aes_key)
        self.log(f"    → write {len(pkt)}B (GCM op=0x0b) {pkt.hex()}")
        self.device.char_write(OLD_WRITE_UUID, pkt)

        def is_gcm_with_op(target_op: int):
            def predicate(raw: bytes) -> Optional[bytes]:
                if len(raw) < 32 or raw[:5] == V3_MAGIC:
                    return None
                plain = decrypt_gcm_v3(raw, self.aes_key)
                if plain is None or len(plain) < 4 or plain[0] != 0x52:
                    return None
                if plain[2] == target_op:
                    return plain
                return None
            return predicate

        ts_reply = self.wait_for(is_gcm_with_op(0x0b), timeout=5.0)
        if not ts_reply:
            self.log("  ✗ no GCM-decryptable 0x0b reply within 5s")
            self.log("    → AES key is wrong, OR robot didn't accept the handshake")
            return False
        self.log(f"  ✓ robot replied: inner={ts_reply.hex()}")

        if len(ts_reply) < 12:
            self.log(f"  ! reply too short to contain timestamp: {ts_reply.hex()}")
            return False
        ts = int.from_bytes(ts_reply[3:11], "little")
        self.log(f"    extracted timestamp: {ts}")

        check_pkt = build_gcm_v3(0x0c, (ts + 1).to_bytes(8, "little"), self.aes_key)
        self.log(f"Step 4: CHECK_3 (0x0c) with ts+1={ts + 1}")
        self.log(f"    → write {len(check_pkt)}B (GCM op=0x0c)")
        self.device.char_write(OLD_WRITE_UUID, check_pkt)

        # Some firmwares reply with op 0x0c ack; if not, just proceed.
        ack = self.wait_for(is_gcm_with_op(0x0c), timeout=2.0)
        if ack:
            self.log(f"  ✓ CHECK_3 ack: {ack.hex()}")
        else:
            self.log("  ! no CHECK_3 ack (some firmwares omit it; continuing)")
        return True

    def step_get_sn(self) -> bool:
        self.log("Step 5: GET_SN (op 0x02) GCM-encrypted")
        pkt = build_gcm_v3(0x02, b"", self.aes_key)
        self.log(f"    → write {len(pkt)}B (GCM op=0x02)")
        self.device.char_write(OLD_WRITE_UUID, pkt)

        def is_sn(raw: bytes) -> Optional[str]:
            if len(raw) < 32 or raw[:5] == V3_MAGIC:
                return None
            plain = decrypt_gcm_v3(raw, self.aes_key)
            if plain is None or len(plain) < 4 or plain[0] != 0x52 or plain[2] != 0x02:
                return None
            sn_bytes = plain[3:plain[1] - 1]
            return sn_bytes.decode("utf-8", errors="replace").strip()

        sn = self.wait_for(is_sn, timeout=5.0)
        if not sn:
            self.log("  ✗ no GCM-decryptable SN reply")
            return False
        self.log(f"  ✓ GCM GET_SN reply: {sn!r}")
        match = "MATCH" if sn == self.f1_sn else f"MISMATCH (F1={self.f1_sn!r})"
        self.log(f"    cross-check vs F1: {match}")
        return True

    def step_get_ap_mac(self) -> bool:
        self.log("Step 6: GET_AP_MAC (op 0x07) GCM-encrypted")
        self.log("  (note: the apk's V3 dispatch never parses MAC bytes — this op")
        self.log("   may just be an ack; AP MAC may not be retrievable on V3.)")
        pkt = build_gcm_v3(0x07, b"", self.aes_key)
        self.log(f"    → write {len(pkt)}B (GCM op=0x07)")
        self.device.char_write(OLD_WRITE_UUID, pkt)

        def parse(raw: bytes) -> Optional[bytes]:
            if len(raw) < 32 or raw[:5] == V3_MAGIC:
                return None
            plain = decrypt_gcm_v3(raw, self.aes_key)
            if plain is None or len(plain) < 4 or plain[0] != 0x52 or plain[2] != 0x07:
                return None
            return plain

        ap = self.wait_for(parse, timeout=3.0)
        if not ap:
            self.log("  ! no 0x07 reply")
            return True  # not fatal
        body = ap[3:ap[1] - 1]
        if len(body) == 6:
            mac = ":".join(f"{b:02X}" for b in body)
            self.log(f"  ✓ GCM GET_AP_MAC reply: {mac}")
        else:
            self.log(f"  • 0x07 reply body ({len(body)}B): {body.hex()} (likely just ack)")
        return True

    def disconnect(self) -> None:
        try:
            if self.device:
                self.device.disconnect()
        except Exception:
            pass
        try:
            if self.adapter:
                self.adapter.stop()
        except Exception:
            pass

    def run(self) -> int:
        if not self.connect():
            return 1
        try:
            if not self.step_secret(): return 2
            if not self.step_fetch_extdata(): return 3
            if not self.step_handshake(): return 4
            if not self.step_get_sn(): return 5
            self.step_get_ap_mac()
            return 0
        finally:
            self.disconnect()


def main():
    addr = sys.argv[1] if len(sys.argv) > 1 else "FC:23:CD:99:67:46"
    aes = sys.argv[2] if len(sys.argv) > 2 else "6c5123186d17a3fc5e7c96e824df8890"
    print(f"== V3 handshake test ==  addr={addr}  aes_key={aes}\n")
    rc = Tester(addr, aes).run()
    print(f"\n== exit code {rc} ==")
    sys.exit(rc)

if __name__ == "__main__":
    main()

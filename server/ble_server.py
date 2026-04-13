#!/usr/bin/env python3
"""
BLE Configuration Server for Unitree Go2
Exposes REST API for scanning, connecting, and configuring robots via BLE.
Also supports connecting to the Unitree BLE remote control.
Runs alongside the Vite dev server — proxied through /ble-api/*.
"""

import asyncio
import logging
import struct
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from bleak import BleakScanner, BleakClient
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


class Cmd(IntEnum):
    HANDSHAKE  = 0x01
    GET_SN     = 0x02
    WIFI_TYPE  = 0x03
    WIFI_SSID  = 0x04
    WIFI_PWD   = 0x05
    COUNTRY    = 0x06
    GET_AP_MAC = 0x07
    DISCONNECT = 0x08


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


# ─── BLE Session ──────────────────────────────────────────────────────

class BLESession:
    """Manages a single BLE connection to a robot."""

    def __init__(self):
        self.client: Optional[BleakClient] = None
        self.write_uuid = OLD_WRITE_UUID
        self.notify_uuid = OLD_NOTIFY_UUID
        self.protocol = "unknown"
        self.address = ""
        self.event = asyncio.Event()
        self.response: Optional[bytes] = None
        self.sn_chunks: dict[int, bytes] = {}
        self.sn_result: Optional[str] = None

    @property
    def connected(self) -> bool:
        return self.client is not None and self.client.is_connected

    def _on_notify(self, sender, data: bytearray):
        raw = bytes(data)
        try:
            plain = ble_decrypt(raw)
        except Exception:
            return
        if len(plain) < 4 or plain[0] != 0x51:
            return

        instruction = plain[2]

        # SN comes in chunks
        if instruction == Cmd.GET_SN and len(plain) >= 6:
            chunk_idx = plain[3]
            total = plain[4]
            chunk_data = plain[5:plain[1] - 1]
            self.sn_chunks[chunk_idx] = chunk_data
            if len(self.sn_chunks) >= total:
                self.sn_result = b"".join(
                    self.sn_chunks[i] for i in sorted(self.sn_chunks)
                ).decode("utf-8").rstrip("\x00")
                self.sn_chunks.clear()
                self.event.set()
            return

        self.response = plain
        self.event.set()

    async def connect(self, address: str) -> str:
        if self.connected:
            await self.disconnect()

        self.address = address

        # Use cached BLEDevice from scan, or do a fresh scan
        device = _scanned_devices.get(address)
        if not device:
            scanner = BleakScanner(scanning_mode="active", bluez={"adapter": _current_adapter})
            device = await scanner.find_device_by_address(address, timeout=10.0)
        if not device:
            raise HTTPException(404, f"Device {address} not found")

        self.client = BleakClient(device, timeout=30.0, bluez={"adapter": _current_adapter})
        await self.client.connect()

        # Detect protocol
        service_uuids = [str(s.uuid).lower() for s in self.client.services]
        if NUS_SERVICE_UUID.lower() in service_uuids:
            self.write_uuid = NUS_TX_UUID
            self.notify_uuid = NUS_RX_UUID
            self.protocol = "nus"
        elif OLD_SERVICE_UUID.lower() in service_uuids:
            self.write_uuid = OLD_WRITE_UUID
            self.notify_uuid = OLD_NOTIFY_UUID
            self.protocol = "ffe0"
        else:
            self.protocol = "unknown"

        await self.client.start_notify(self.notify_uuid, self._on_notify)
        await asyncio.sleep(0.5)
        self.event.clear()
        self.response = None

        return self.protocol

    async def disconnect(self):
        if self.client and self.client.is_connected:
            await self.client.disconnect()
        self.client = None
        self.address = ""

    async def _write_and_wait(self, packet: bytes, timeout: float = 5.0) -> Optional[bytes]:
        self.event.clear()
        self.response = None
        await self.client.write_gatt_char(self.write_uuid, packet, response=False)
        try:
            await asyncio.wait_for(self.event.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return self.response

    async def handshake(self) -> bool:
        pkt = build_chunked(Cmd.HANDSHAKE, b"unitree", idx=1, total=1)
        resp = await self._write_and_wait(pkt)
        return resp is not None and len(resp) > 3 and resp[3] == 0x01

    async def get_serial_number(self) -> Optional[str]:
        self.sn_result = None
        self.sn_chunks.clear()
        self.event.clear()
        pkt = build_simple(Cmd.GET_SN)
        await self.client.write_gatt_char(self.write_uuid, pkt, response=False)
        try:
            await asyncio.wait_for(self.event.wait(), 5.0)
        except asyncio.TimeoutError:
            pass
        # Wait a bit more for extra chunks
        await asyncio.sleep(0.5)
        return self.sn_result

    async def get_ap_mac(self) -> Optional[str]:
        pkt = build_simple(Cmd.GET_AP_MAC)
        resp = await self._write_and_wait(pkt)
        if resp and len(resp) > 4:
            mac_bytes = resp[3:resp[1] - 1]
            return ":".join(f"{b:02X}" for b in mac_bytes)
        return None

    async def set_wifi(self, ssid: str, password: str, ap_mode: bool = False, country: str = "US") -> dict:
        results = {}

        # Set mode
        mode_byte = 0x01 if ap_mode else 0x02
        resp = await self._write_and_wait(build_simple(Cmd.WIFI_TYPE, bytes([mode_byte])))
        results["mode"] = resp is not None and len(resp) > 3 and resp[3] == 0x01

        # Send SSID
        ssid_bytes = ssid.encode("utf-8")
        total = (len(ssid_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
        for i in range(total):
            chunk = ssid_bytes[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            pkt = build_chunked(Cmd.WIFI_SSID, chunk, idx=i + 1, total=total)
            if i + 1 < total:
                await self.client.write_gatt_char(self.write_uuid, pkt, response=False)
                await asyncio.sleep(0.05)
            else:
                resp = await self._write_and_wait(pkt)
                results["ssid"] = resp is not None and len(resp) > 3 and resp[3] == 0x01

        # Send password
        pwd_bytes = password.encode("utf-8")
        total = (len(pwd_bytes) + CHUNK_SIZE - 1) // CHUNK_SIZE
        for i in range(total):
            chunk = pwd_bytes[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            pkt = build_chunked(Cmd.WIFI_PWD, chunk, idx=i + 1, total=total)
            if i + 1 < total:
                await self.client.write_gatt_char(self.write_uuid, pkt, response=False)
                await asyncio.sleep(0.1)
            else:
                self.event.clear()
                self.response = None
                await self.client.write_gatt_char(self.write_uuid, pkt, response=False)
                try:
                    await asyncio.wait_for(self.event.wait(), 15.0)
                    results["password"] = self.response is not None and len(self.response) > 3 and self.response[3] == 0x01
                except asyncio.TimeoutError:
                    results["password"] = False

        # Set country
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

    def __init__(self):
        self._adapter: Optional[pygatt.GATTToolBackend] = None
        self._device = None
        self.address = ""
        self.name = ""
        self.latest_state: Optional[dict] = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected and self._device is not None

    def _on_notify(self, handle, value):
        raw = bytes(value)
        if len(raw) < 20:
            return
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

    async def connect(self, address: str) -> None:
        if self.connected:
            await self.disconnect()

        self.address = address

        # Resolve name from scan cache
        cached = _scanned_devices.get(address)
        self.name = (cached.name if cached and hasattr(cached, 'name') else "") or ""

        # pygatt is synchronous — run in executor
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._connect_sync, address)

    def _connect_sync(self, address: str) -> None:
        self._adapter = pygatt.GATTToolBackend(hci_device=_current_adapter)
        self._adapter.start()
        try:
            self._device = self._adapter.connect(
                address, address_type=pygatt.BLEAddressType.public, timeout=15,
            )
        except Exception as e:
            self._adapter.stop()
            self._adapter = None
            raise HTTPException(500, f"Remote connect failed: {e}")

        # Handshake
        handshake = "".join(f"{ord(c):x}" for c in "YS+2").encode("utf-8")
        self._device.char_write(OLD_WRITE_UUID, handshake)

        # Subscribe
        self._device.subscribe(OLD_NOTIFY_UUID, callback=self._on_notify)
        self._connected = True

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

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
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
                current["up"] = "UP" in line and "RUNNING" in line
            elif current and "Manufacturer:" in line:
                current["type"] = line.split("Manufacturer:")[1].strip()
    except Exception:
        pass
    return {"adapters": adapters, "current": _current_adapter}


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
    devices = await BleakScanner.discover(
        timeout=timeout, return_adv=True, scanning_mode="active",
        bluez={"adapter": _current_adapter},
    )
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
    }


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


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=5051)

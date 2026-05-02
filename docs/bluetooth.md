# Bluetooth

Configure the robot's WiFi and pair the BLE remote control without the phone app. Open from the landing page → **Bluetooth** tile.

## Robot Provisioning

<p align="center">
  <img src="../images/bluetooth_robot.png" width="70%" />
</p>

Scan, connect, fetch SN + AP MAC, configure WiFi (SSID, password, STA / AP mode, region). Adapter selector for switching between multiple HCI adapters (handy with USB dongles).

Protocol versions:

- **V1 / V2** — used by Go2 (all firmware) and G1 `< 1.5.1`. Standard Nordic UART or FFE0 service. See [bluetooth-v1-v2.md](bluetooth-v1-v2.md) for the full GATT layout and command schema.
- **V3** — G1 `≥ 1.5.1` only. Adds two new characteristics: `VERSION` (`0xF1`) and `GCM_KEY` (`0xF2`). The UI gates V3 probes on the scanned BLE name (`/^G1[_\W]/i`) so Go2 robots never see V3 traffic. See [bluetooth-v3.md](bluetooth-v3.md) for the magic-prefix handshake and key-exchange details.

## Remote Control

<p align="center">
  <img src="../images/bluetooth_remote.png" width="70%" />
</p>

Pair the Unitree BLE remote (`Unitree-*` advertising name) to read live joystick axes and button states, with an Hz counter showing the update rate.

Once paired, a gamepad icon appears in the control view's setting bar — click it to relay the remote's input to the robot over the WebRTC `rt/wirelesscontroller` channel:

<p align="center">
  <img src="../images/bt_relay_button.png" width="50%" />
</p>

Full protocol details and frame layout in [remote-control.md](remote-control.md).

## Running the BLE Server

The dev `npm run start` script launches both Vite and the Python BLE backend together. To run them separately:

```bash
pip install -r server/requirements.txt
npm run ble-server     # Python FastAPI BLE backend
npm run dev            # Vite frontend (no BLE)
```

The frontend talks to the BLE server through Vite's `/ble-api/*` proxy, so CORS isn't a concern.

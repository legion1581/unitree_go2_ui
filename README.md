# Unitree Go2 WebRTC UI

A browser-based control interface for the Unitree Go2 robot dog, communicating over WebRTC. Built with TypeScript, Three.js, and Vite.

![Status](https://img.shields.io/badge/status-beta-yellow)
![Browser](https://img.shields.io/badge/tested-Chrome-brightgreen)

![Control View](images/control-view-new.png)

<p align="center">
  <img src="images/connection.png" width="24%" />
  <img src="images/hub.png" width="24%" />
  <img src="images/status.png" width="24%" />
  <img src="images/services.png" width="24%" />
</p>

<p align="center">
  <img src="images/account-manager.png" width="60%" />
</p>

## Features

- **Real-time 3D visualization** — Go2 model with live joint angles, lidar spinning animation, and voxel point cloud (SLAM)
- **Camera feed** — Live video with PIP view swap (camera/voxel)
- **Dual joystick control** — Move and rotate the robot
- **Action bar** — Roll over, stretch, shake hand, dance, flips, and more (customizable carousel)
- **Mode switching** — Damping, free walk, sit, crouch, run, walk stair, hand stand, bound, cross step, etc.
- **Robot status** — Battery, motor data (temp, position, torque, lost packets), IMU, LiDAR state, network info
- **Service manager** — View all running services, start/stop with protection handling
- **Account Management** — Unitree cloud account: devices, firmware, tutorials, sharing, debug API console
- **Bluetooth Setup** — Configure robot WiFi over BLE (scan, connect, STA/AP mode) without the phone app
- **Remote Control** — Connect to the Unitree BLE remote, live joystick/button visualization with Hz counter
- **Connection modes:**
  - **Local Network (STA-L)** — Direct connection via IP on same network
  - **Access Point (AP)** — Direct connection at 192.168.12.1
  - **Remote** — Cloud connection via Unitree account (email/password or token)
- **Network scanner** — UDP multicast auto-discovery of robots on the network
- **Firmware info** — Package version fetched via bashrunner

## Prerequisites

- Node.js >= 18
- npm >= 9
- Unitree Go2 robot (firmware v1.1.x+)

## Installation

```bash
git clone https://github.com/legion1581/unitree_go2_ui.git
cd unitree_go2_ui
npm install
```

## Usage

### Development

```bash
npm run start        # Starts Vite + BLE server together
npm run start:no-ble # Vite only (no Bluetooth features)
npm run dev          # Vite only (same as start:no-ble)
```

Open http://localhost:5173 in **Chrome** (recommended).

The dev server includes:
- Hot module replacement
- Built-in UDP multicast scanner (no separate process needed)
- Proxy for robot API, Unitree cloud API, and BLE server (avoids CORS)

### Production Build

```bash
npm run build
npm run preview
```

## Connecting to the Robot

### Local Network (recommended)

1. Connect your computer to the same network as the Go2
2. Select **Local Network** mode
3. Click **Scan** to auto-discover the robot, or enter the IP manually
4. Click **Connect**

### Access Point

1. Connect to the Go2's WiFi hotspot
2. Select **Access Point** mode (IP is auto-filled to 192.168.12.1)
3. Click **Connect**

### Remote

1. Select **Remote** mode
2. Enter your Unitree account email/password (or paste an access token)
3. Click **Login** — your robots load automatically
4. On the hub, click **WebRTC Connect** to establish the video/control stream
5. If your account has multiple robots, use the dropdown to pick one before connecting

## Bluetooth

Bluetooth configuration overlay available from any screen via the **BT icon** in the upper-right corner.

<p align="center">
  <img src="images/bluetooth-popover-1.png" width="45%" />
  <img src="images/bluetooth-popover-2.png" width="45%" />
</p>

- **Scan & connect** — discover and connect to Go2 robots and Unitree BLE remote controls
- **Adapter selection** — switch between multiple HCI adapters (useful with USB dongles)
- **Robot** — fetch serial number and AP MAC, configure WiFi (SSID, password, STA/AP mode, region)
- **Remote** — read live joystick axes and button states, relay them to the robot over WebRTC (`rt/wirelesscontroller`)

### Relay the BT Remote to the Robot

When a BLE remote control is connected, a gamepad icon appears in the control view's setting bar (alongside Radar, LiDAR, Volume, Light). Click it to forward the remote's joystick axes and buttons to the robot — the on-screen virtual joysticks hide while relay is active.

<p align="center">
  <img src="images/bt-relay-button.png" width="60%" />
</p>

See [docs/bluetooth.md](docs/bluetooth.md) for the full protocol reference.

```bash
# Or run the BLE server separately:
pip install -r server/requirements.txt
npm run ble-server
```

## Account Management

Available in Remote mode via the hub. Provides access to the Unitree cloud API without needing the phone app.

- **Devices** — list robots with online status, details, firmware downloads, sharing, bind/unbind
- **Info** — app version with APK download, grouped video tutorials, changelog, announcements
- **Account** — profile, avatar, password, region, session management
- **Debug** — raw API console with 77 endpoints across 13 categories (Auth, Devices, Firmware, WebRTC, Wallet, etc.)

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome | Tested, fully working |
| Firefox | Experimental (WebRTC data channel timing differences) |
| Safari | Not tested |

## Project Structure

```
src/
  api/              # Unitree cloud API client (account, devices, firmware, etc.)
  connection/       # WebRTC, local/remote connectors, network scanner
  crypto/           # AES-ECB, RSA, AES-GCM for auth and SDP exchange
  protocol/         # Data channel handler, topics, sport commands
  ui/
    components/     # Action bar, PIP camera, status/services/account pages, nav bar
    scene/          # Three.js scene, robot model, voxel map
  proxy-plugin.ts   # Vite plugin: robot proxy, scanner, cloud API, BLE API proxy
public/
  icons/            # Action and mode SVG icons
  sprites/          # UI sprites and backgrounds
  models/           # Go2.glb 3D model
server/
  ble_server.py     # FastAPI BLE backend (scan, connect, WiFi config)
  scanner.mjs       # Standalone UDP multicast scanner (optional)
```

## Sport Commands (API IDs)

Actions and modes use the MCF sport API IDs matching firmware v1.1.11:

| Action | ID | Mode | ID |
|--------|----|------|----|
| Roll Over | 1021 | Damping | 1001 |
| Stretch | 1017 | Free Walk | 2045 |
| Shake Hand | 1016 | Sit Down | 1009 |
| Heart | 1036 | Crouch | 1005 |
| Pounce | 1032 | Run | 1011 |
| Jump Forward | 1031 | Walk Stair | 1049 |
| Greet | 1029 | Lock On | 1004 |
| Dance 1 | 1022 | Static Walk | 1061 |
| Dance 2 | 1023 | Endurance | 1035 |
| Front Flip | 1030 | Leash | 2056 |
| Back Flip | 2043 | Hand Stand | 2044 |
| Left Flip | 2041 | Free Avoid | 2048 |
| | | Bound | 2046 |
| | | Jump | 2047 |
| | | Stand | 1006 |
| | | Cross Step | 2051 |

## License

MIT

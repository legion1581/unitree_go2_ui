# Connecting to the Robot

The UI talks to Go2 and G1 over the same WebRTC handshake the official Unitree mobile app uses. You pick the robot family on the landing page; the Connect screen then offers three transport modes.

<p align="center">
  <img src="../images/landing.png" width="80%" />
</p>

## Family Selection

The landing page has two slots:

- **Account** — which family the cloud client signs as (`AppName: Go2` vs `AppName: G1`). Used for `device/bind/list`, tutorials, firmware listings.
- **Connect** — which family the local/remote WebRTC connector targets.

Both are persisted independently in `localStorage` so you can, for example, log in with a Go2 account and connect to a G1 on LAN.

## Connect Screen

<p align="center">
  <img src="../images/connect_go2.png" width="48%" />
  <img src="../images/connect_g1.png" width="48%" />
</p>

Three modes:

- **Local Network (STA-L)** — robot and client on the same LAN. Fill in the IP, or click **Scan** to auto-discover.
- **Access Point (AP)** — connect to the robot's own WiFi hotspot. IP is auto-filled (`192.168.12.1`).
- **Remote** — through Unitree's TURN/relay infrastructure. Requires an Unitree cloud session (Account tab).

The IP/SN inputs are namespaced per family in `localStorage` (`unitree_last_ip_<family>`, `unitree_last_sn_<family>`), so switching Go2 ↔ G1 doesn't trample your last-known IP.

## Network Scan

Click **Scan** to UDP-multicast for robots on the LAN. The dev server's Vite plugin runs the scanner internally, so no separate process is needed.

- **Go2** — multicast group `231.1.1.1`, port `10131`. No SN filter, returns every Go2 on the network.
- **G1 < 1.5.1** — group `239.255.1.1`, port `10134`. Broadcast scan returns all G1s.
- **G1 ≥ 1.5.1** — same group/port, but the firmware now filters by SN. The scan does a broadcast first, then a per-SN sweep over devices bound to your cloud account plus any SN you typed manually. Results are deduped by SN.

If your account already has the device bound, the SN field auto-populates from the scan; otherwise paste the SN from the back of the robot.

## G1 ≥ 1.5.1 — AES-128 Key (`data2=3`)

Starting with G1 firmware **1.5.1**, the LAN signaling reply (`con_notify`) returns `data2=3`, meaning the embedded RSA public key is wrapped under a **per-device AES-128-GCM key**. Older firmware (and all Go2) returns `data2=2` (static GCM key, handled transparently).

The key is per-device and stable across re-pairings. The UI gets it three ways, in order:

1. **Cloud-primed cache** — when you log in to Account, `device/bind/list` is fetched and every `dev.key` is stored as `(sn → key)` in `localStorage` under `unitree_aes_keys_v1`. Subsequent connects pull from there silently.
2. **Manual prompt** — if no cached key matches, a modal asks for the 32-hex AES key for that SN. The entry is cached for next time.
3. **Retry** — wrong key flushes the cache and reprompts (up to 3 attempts) with a "previous key didn't decrypt" banner so you don't keep entering the same wrong value.

Connection logs (`[g1] AES-128 key from localStorage cache (SN ...)` / `[g1] AES-128 key (prompted) — cached for SN ...`) tell you which path was taken.

## Tutorials

The hub pulls the same tutorial videos the mobile app shows. The query is `tutorial/list?appName=<family>&type=<model>` — `appName` is the family literal (`Go2`/`G1`), not the HTTP `AppName` signing header (which uses `Go2`/`B2` on the cloud side).

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome  | Tested, fully working |
| Firefox | Experimental — WebRTC data channel timing differs |
| Safari  | Not tested |

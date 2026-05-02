# Account Manager

Talks to Unitree's cloud API directly — no phone app required. Sign in with your Unitree credentials (or paste an access token), and the same surface area the mobile app uses opens up: device list, firmware images, tutorials, sharing, raw API console.

<p align="center">
  <img src="../images/hub.png" width="80%" />
</p>

## Sign-in

Two paths:

- **Email + password** — standard login, session is persisted in `localStorage` and refreshed automatically.
- **Access token** — paste an existing `accessToken`; useful if you've fetched one with the `unitree-fetch-aes-key` CLI from [unitree_webrtc_connect](https://github.com/legion1581/unitree_webrtc_connect) or extracted it from the phone app.

The **family slot** on the landing page determines which `AppName` header signs cloud requests — `Go2` accounts hit `global-robot-api.unitree.com` with `AppName: Go2`; G1 accounts use `AppName: B2`. Pick the one your account is registered under.

## Tabs

### Devices
Robots bound to your account: online status, alias, SN, model, firmware version. Per-device actions: bind/unbind, share, fetch firmware images, view detail. Logging in here also primes the AES-128 key cache for any G1 ≥ 1.5.1 device by pulling `dev.key` from `device/bind/list`.

### Info
App version with APK download links, grouped video tutorials (queried as `tutorial/list?appName=<family>&type=<model>`), changelog, and announcements.

### Account
Profile, avatar, password change, region, session management.

### Debug
Raw API console — 77 endpoints across 13 categories (Auth, Devices, Firmware, WebRTC, Wallet, etc.). Lets you fire any cloud request with custom params and inspect the JSON response. Useful for protocol reverse-engineering or one-off operations that don't have a dedicated UI yet.

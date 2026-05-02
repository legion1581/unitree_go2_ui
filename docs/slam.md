# 3D LiDAR Mapping (SLAM) — Unitree Go2

The Mapping page in this UI talks to the robot's `uslam_server` (the on-board SLAM module) over WebRTC and lets the user build maps, localize on saved maps, navigate to a goal, run a patrol loop, and dock for auto-charging — all from the browser. This document covers the topics involved, the user-facing flow, the local data model, and the firmware-side state machine.

![SLAM view](../images/slam.png)

## Table of Contents

- [Overview](#overview)
- [Page Layout](#page-layout)
- [Topics](#topics)
  - [Command channel](#command-channel)
  - [Status feeds](#status-feeds)
  - [File transfer](#file-transfer)
  - [Shared topics](#shared-topics)
- [User Flow (Stepper)](#user-flow-stepper)
- [Mapping](#mapping)
- [Localization](#localization)
- [Navigation](#navigation)
  - [Go to Goal](#go-to-goal)
  - [Patrol](#patrol)
  - [Patrol Limits](#patrol-limits)
- [Auto-Charge](#auto-charge)
- [Map Storage](#map-storage)
  - [Why a local cache](#why-a-local-cache)
  - [IndexedDB layout](#indexeddb-layout)
  - [Zip Import / Export](#zip-import--export)
- [Status Queries](#status-queries)
- [Theme + Smoothing](#theme--smoothing)
- [Known Quirks](#known-quirks)
- [Files](#files)

---

## Overview

The SLAM stack on the Go2 is exposed by **`uslam_server`** (ARM64 ELF at `/unitree/module/unitree_lidar_slam/bin/uslam_server`). It speaks DDS internally and the WebRTC bridge surfaces those topics to the browser. All command traffic is **plain string** publications on a single topic; data feeds (point clouds, odometry, paths) come back on per-module topics. There is no API-ID protocol here — just `module/action[/arg1/arg2/...]` strings.

The on-board module exposes ~56 commands across 8 namespaces (`mapping`, `localization`, `navigation`, `patrol`, `autocharge`, `frontend`, `control`, `common`). This UI drives the user-facing subset (the same one the official Unitree app uses).

## Page Layout

| Region | Content |
|---|---|
| Header | back button, title, motor temp, battery, network type, theme, BT — same shape as the Control NavBar |
| Stepper banner | `Step 1: Mapping ➜ Step 2: Localization ➜ Step 3: Navigation` with green/yellow/grey state |
| Live detail bar | Compact line under the stepper showing nav/patrol/charge sub-state |
| Left sidebar | Send Command (template picker), Server Log (with source-topic indicator + Copy) |
| 3D viewport | Three.js scene + draggable PiP video feed |
| Right sidebar | Step 1: Mapping, Step 2: Localization, Step 3: Navigation (Goal/Patrol tabs), Autocharge |

## Topics

Constants are defined in [src/protocol/topics.ts](../src/protocol/topics.ts).

### Command channel

| Topic | Direction | Format |
|---|---|---|
| `rt/uslam/client_command` (`USLAM_CMD`) | client → robot | string `module/action[/arg.../arg]` |

Every SLAM command we send goes on this topic. The robot acknowledges via paired success/failed messages on the server-log topic (e.g. `mapping/start/success`, `localization/set_initial_pose/failed`).

### Status feeds

All received over the WebRTC DataChannel.

| Topic | Constant | Payload | Purpose |
|---|---|---|---|
| `rt/uslam/server_log` | `USLAM_SERVER_LOG` | std_msgs/String | Command acks, state transitions, log lines |
| `rt/uslam/frontend/cloud_world_ds` | `USLAM_CLOUD_WORLD` | binary, voxel-compressed | Live downsampled world cloud (during mapping) |
| `rt/uslam/frontend/odom` | `USLAM_ODOM` | nav_msgs/Odometry | Mapping-frame odometry |
| `rt/uslam/cloud_map` | `USLAM_CLOUD_MAP` | binary (PCD) | Final map cloud (delivered post-stop) |
| `rt/uslam/localization/cloud_world` | `USLAM_LOC_CLOUD` | sensor_msgs/PointCloud2 | Real-time localization scan in world frame |
| `rt/uslam/localization/odom` | `USLAM_LOC_ODOM` | nav_msgs/Odometry | Robot pose during localization |
| `rt/uslam/navigation/global_path` | `USLAM_NAV_PATH` | sensor_msgs/PointCloud2 | Planned global path |
| `rt/mapping/grid_map` | `USLAM_GRID_MAP` | binary | 2-D occupancy grid (subscribed but not currently rendered) |

Subscription strategy (matches the APK's deferred-subscription pattern):

- **On page entry** — subscribe BASE topics: `USLAM_SERVER_LOG`, `USLAM_CLOUD_WORLD`, `USLAM_ODOM`, `USLAM_CLOUD_MAP`, `USLAM_GRID_MAP`.
- **On `[Localization] initialization succeed!`** — additionally subscribe LOC topics: `USLAM_LOC_CLOUD`, `USLAM_LOC_ODOM`, `USLAM_NAV_PATH`.
- **On localization stop / failure / page leave** — unsubscribe LOC topics.
- **On page leave** — unsubscribe BASE topics; **`LOW_STATE` is intentionally not in this list** (it's globally subscribed by `app.ts:enableVideoAndSubscribe()` and shared with the NavBar).

### File transfer

Map artefacts (`.pcd`, `.pgm`, `.txt`) move over the **`RTC_INNER_REQ`** WebRTC subprotocol with `related_bussiness: "uslam_final_pcd"`. Two ops:

| Op | `req_type` | Direction |
|---|---|---|
| Read a file | `request_static_file` | client → robot, response carries chunked base64 |
| Write a file | `push_static_file` | client → robot, multi-chunk upload with per-chunk ack `{file_status: "ok"}` |

`pushFile` in [src/protocol/data-channel.ts](../src/protocol/data-channel.ts) implements the upload side: 30 KB chunks, 500 ms breather every 5 chunks, per-chunk timeout 10 s, sequential to keep the response handler chain unambiguous.

### Shared topics

| Topic | Constant | Notes |
|---|---|---|
| `rt/lf/lowstate` | `LOW_STATE` | Battery, motor temps — globally subscribed by `app.ts`; surfaced in the mapping page header |
| `rt/utlidar/switch` | `LIDAR_SWITCH` | Hardware on/off |

## User Flow (Stepper)

The right sidebar mirrors the stepper sequence:

| Step | Section | Goal |
|---|---|---|
| 1 | Mapping | Build a fresh point-cloud map (or load a saved one) |
| 2 | Localization | Tell the robot where it is on that map |
| 3 | Navigation | Drive to a goal or run a patrol loop |
| extra | Autocharge | Dock and charge (manual or automatic) |

Each step is gated:
- Mapping is always available.
- Localization unlocks once a map is loaded (`mapLoaded === true`).
- Navigation unlocks once `mapLoaded && localized`.
- Autocharge unlocks with the same condition as Navigation.

The stepper colour-codes the steps: **green = passed, yellow = current, grey = not reached**.

## Mapping

User clicks **New Map**:

1. `slamScene.clearAll()` + worker `clear` (drops accumulated points).
2. Mint a client-side map ID (`generateMapId()` → 16 random bytes, URL-safe base64). The robot's `mapping/stop` does *not* generate a fresh ID, so we mint our own and push it via `set_map_id` after the stop.
3. Send `mapping/start`.
4. While mapping runs, `cloud_world_ds` packets arrive at ~5 Hz; the SLAM Worker dequantizes them via `libslam.wasm` into Float32Array positions and pushes them into the Three.js point cloud.

User clicks **Stop & Save**:

1. Send `mapping/stop`.
2. On `mapping/stop/success`: clear the live laser cloud, send `common/set_map_id/<minted-id>` to label the freshly-saved map.
3. On `set_map_id/success`: open the Save Map modal.
4. After the user names it, write the metadata to `localStorage` (`go2_slam_maps`) and download the full bundle (PCD + PGM + TXT) into IndexedDB.

The robot only has **one physical map slot** at `/unitree/module/unitree_lidar_slam/data/map_data/`. Subsequent mappings overwrite the same files. That's why we cache locally — see [Map Storage](#map-storage).

## Localization

User drags a pose marker on the map → release fires `localization/set_initial_pose/{x}/{y}/{yaw}` (yaw in radians, CCW from +X). 100 ms later we auto-issue `localization/start`.

Server-log strings drive the UI transitions:
- `[Localization] initialization succeed!` → subscribe LOC topics, show robot model, light up Localization step + Navigation gate.
- `[Localization] initialization failed!` → unsubscribe LOC topics, highlight "Set Initial Pose" with a hint to re-anchor.

Once localized, the live laser scan (`USLAM_LOC_CLOUD`) is rendered in white (dark theme) or accent blue (light theme) on top of the cached map cloud, and the Go2 model tracks `USLAM_LOC_ODOM` with frame-rate-driven smoothing (see [Theme + Smoothing](#theme--smoothing)).

## Navigation

The Navigation step has two tabs: **Go to Goal** and **Patrol**.

### Go to Goal

User holds-and-drags a pose on the map. On release:

1. If `navigationActive === false`, send `navigation/start` first (the robot wouldn't move otherwise — `set_goal_pose` on a stopped nav module just registers the target). This auto-start makes "drag a goal → robot drives there" Just Work.
2. Send `navigation/set_goal_pose/{x}/{y}/{yaw}`.
3. Place a pole marker at the goal pose for visual reference.

Sub-state handling on `navigation/state_transition/<STATE>`:

| State | Behaviour |
|---|---|
| `WAITING` / `TRACKING` | informational only |
| `REACHED` | clear goal marker + path; toast "goal reached"; if `autoChargeOnReach` is armed, fire `autocharge/start` |
| `NO_PATH` | clear path; toast "No path to goal" |
| `TIMEOUT` | toast "Navigation timed out" |
| `GOAL_OCCUPIED` | toast "Goal location is occupied" |
| `GOAL_CHANGED` | toast "Goal changed" |
| `FAILURE` | clear path + goal marker; **no main-state change** — `navigationActive` stays true so the user can dispatch another goal without re-pressing Start |
| `GOAL_CANCELLED` | informational; clear path |

### Patrol

Add waypoints (hold-and-drag), then **Execute Patrol**. The execute sequence matches the APK's `handleSureExecutePatrol`:

```
1. patrol/start                          ← MUST be first; puts the module in INITIALIZE
2. wait 500 ms
3. patrol/clear_all_patrol_points
4. patrol/add_patrol_point/{x}/{y}/{yaw} × N
5. patrol/set_total_time_limit/{n}
   patrol/set_patrol_time_limit/{n}
   patrol/set_charge_time_limit/{n}
   patrol/set_patrol_number_limit/{n}
   patrol/set_bms_soc_limit/{min}/{max}
6. patrol/go
```

> **Important:** `patrol/start` MUST come first. After a previous `patrol/stop` the module is idle and rejects all `add_patrol_point` and `set_*_limit` commands. They only succeed in the INITIALIZE window after `start`. This also means the standalone "Apply" buttons on each limit input *fail when patrol is idle* — the values are persisted in a local `patrolConfig` store and re-sent every Execute Patrol.

Yaw is sent **as-is**, in radians, CCW from +X. There is no `± π` adjustment despite earlier APK code suggesting one — it produces values outside `[−π, π]` that the navigator flags as `GOAL_POINT_UNREACHABLE`. The patrol module persists waypoints to `/unitree/.../map_data/patrol_points.txt`; if that file has stale yaws from an older build, `patrol/start` will load them instead of your fresh `add_patrol_point` calls. Truncate it manually if you suspect drift.

### Patrol Limits

All values stored in a per-page `patrolConfig` and re-sent on every Execute Patrol.

| Limit | Default | Trigger when reached |
|---|---|---|
| `patrol/set_patrol_time_limit/{s}` | `-1` (unlimited) | `REACH_PATROL_TIME_LIMIT` → `NEED_CHARGE` → dock |
| `patrol/set_total_time_limit/{s}` | `-1` (unlimited) | `REACH_TOTAL_TIME_LIMIT` |
| `patrol/set_charge_time_limit/{s}` | `-1` | maximum dock dwell time |
| `patrol/set_patrol_number_limit/{n}` | `-1` (unlimited) | `REACH_PATROL_NUMBER_LIMIT` |
| `patrol/set_bms_soc_limit/{min}/{max}` | `10/80` | `min`: SOC drops below → `NEED_CHARGE`. `max`: SOC charged up to → resume. Binary rejects `0/100` as out-of-range; use `1/99` to effectively disable |

`patrol/clear_user_config` resets all to firmware defaults.

There is **no `get_*_limit` query** — the binary only exposes setters. Current values are cached client-side once Apply is pressed.

## Auto-Charge

The autocharge module is a **lidar-only plate detector** — no AprilTag, no fiducial. It uses PCL `EuclideanClusterExtraction` + `KdTreeFLANN` to look for a flat 300×200 mm cluster at the configured `plate_distance` (default 0.47 m). State sequence:

```
GO_TO_CHARGE_BOARD     ← driving up to the dock
CONNECTING             ← contact attempt
TIMEOUT_DETECT         ← couldn't see/align with the plate
TIMEOUT_CONNECT_POWER  ← contacts didn't mate
SUCCESS / FAILURE / EXIT
```

UI flow (Autocharge section):
- **Go to Charging Station**: ensures `navigation/start` + 1 s delay + `navigation/set_goal_pose/-0.150/0.000/0.000`; arms `autoChargeOnReach`. On `navigation/state_transition/REACHED` we then fire `autocharge/start`.
- **Cancel Charge**: sends `navigation/stop` + `autocharge/stop`, clears markers (mirrors APK's `_A`).
- **Plate distance (m)**: `autocharge/set_plate_distance/{m}` — adjust if the dock isn't being detected.
- **Get Status**: `autocharge/get_status` round-trip with 2 s timeout.
- **Disable in Patrol**: one-click sets `bms_soc_limit/1/99 + patrol_time_limit/-1 + charge_time_limit/0 + autocharge/stop` so the patrol module never enters NEED_CHARGE on its own.

Retry on `autocharge/state_transition/FAILURE` is capped at 5 attempts (`AUTO_CHARGE_MAX_RETRIES`); each retry re-issues the dock goal pose and re-arms `autoChargeOnReach`.

## Map Storage

### Why a local cache

The robot has **one physical map slot**. Anything saved there gets overwritten on the next `mapping/start`. The official Unitree app stores maps in their cloud and re-uploads them when the user picks one. We replicate the same architecture with **IndexedDB** instead of cloud, plus a `push_static_file` upload to the robot before each Load.

### IndexedDB layout

Database `go2_slam`, store `pcds`, schema v2.

```ts
// keyed by robot map ID (URL-safe base64)
interface MapBundle {
  pcd: ArrayBuffer;   // 3D point cloud — required, used to render
  pgm?: ArrayBuffer;  // 2D occupancy grid (used by the robot, not the viewer)
  txt?: ArrayBuffer;  // origin/resolution metadata
}
```

[`src/storage/map-pcd-store.ts`](../src/storage/map-pcd-store.ts) wraps the standard CRUD: `putBundle`, `getBundle`, `deleteBundle`, `listBundleIds`. Bundle payloads are stored alongside a `localStorage` index (`go2_slam_maps`) of `{id, name, date}` records that drives the saved-maps UI list.

**Save flow** (after `set_map_id/success`):
1. Save the `{id, name, date}` to localStorage.
2. Sequentially fetch `map.pcd`, `map.pgm`, `map.txt` from the robot via `request_static_file` (sequential — concurrent calls would clobber the data-channel response handler chain).
3. Write the bundle into IndexedDB.

**Load flow:**
1. Read the bundle from IndexedDB.
2. Render the cached PCD immediately for fast feedback.
3. If `robotSlotMapId === mapId`, skip the upload — the robot already has these files. Otherwise upload all three via `pushFile` (chunked `push_static_file`).
4. Send `common/set_map_id/{id}` to make the slot active.
5. Update `robotSlotMapId` so future Loads of the same id can skip the upload.

The fallback path (no cached bundle) renders whatever is currently in the robot's slot **without writing it back to IndexedDB** — `set_map_id` only relabels and the bytes might not actually correspond to that id.

### Zip Import / Export

Each saved-map row has **Export**, and the Saved Maps section header has **Import .zip**.

Zip layout:
```
metadata.json   { id, name, date }
map.pcd         required
map.pgm         optional
map.txt         optional
```

Implemented in [`map-pcd-store.ts`](../src/storage/map-pcd-store.ts) using the [`fflate`](https://github.com/101arrowz/fflate) zip codec. Useful for sharing maps between devices, archiving, or hand-editing the PCD with PCL viewers.

## Status Queries

All Promise-based, 2 s timeout, single-resolver pattern matching the APK:

| Query | Topic | Resolves with |
|---|---|---|
| `queryMappingStatus()` | `mapping/get_status` | `'1'` active / `'0'` inactive / `'-1'` timeout |
| `queryLocalizationStatus()` | `localization/get_status` | `'1'` / `'0'` / `'-1'` |
| `queryPatrolStatus()` | `patrol/get_status` | `'1'` / `'0'` / `'-1'` |
| `queryNavigationStatus()` | `navigation/get_status` | `'1'` / `'0'` / `'-1'` |
| `queryAutoChargeStatus()` | `autocharge/get_status` | `'1'` / `'0'` / `'-1'` |
| `queryCurrentMapId()` | `common/get_map_id` | id string or empty on timeout |

`preloadRobotState()` runs all five in parallel on page entry, then restores UI state:
- `mapping=1` → show mapping in progress.
- `loc=1` → mark localized, subscribe LOC topics, fetch active map id, render its cached PCD.
- `patrol=1` → enter patrol mode, request waypoints back from the robot.
- `nav=1` → mark `navigationActive`, switch the nav controls to Stop.
- `autocharge=1` → log "autocharge already running".

## Theme + Smoothing

- The 3D scene reacts to dark/light toggle: `SlamScene` listens to `theme().onChange()` and re-tints the renderer clear color, scene background, grid lines, and the live laser cloud (white on dark, accent blue on light).
- Robot-pose smoothing is **render-driven**, not event-driven. Odom updates are throttled to 50 ms (matches APK at 20 Hz) and only set a `targetPos` / `targetQuat`; the `animate()` loop lerps the robot model toward that target every render frame at `0.15`. This absorbs per-sample SLAM jitter and produces a continuously-moving model regardless of input rate.

## Known Quirks

- `patrol/stop` also stops the navigation module on the firmware side; we sync `navigationActive = false` on either `patrol/stop/success` or a standalone `navigation/stop/success`.
- `patrol/pause` aborts the current navigation goal (`GOAL_CANCELLED → FAILURE`); resume re-plans from the current pose, which can occasionally fail one segment before recovering.
- `set_bms_soc_limit/0/100` is rejected; use `1/99` to effectively disable battery-triggered docking.
- `patrol/start` auto-loads from `/unitree/.../map_data/patrol_points.txt`. If the file is stale (e.g. from an older build that subtracted π from yaws), the robot uses the file values, not your in-memory `add_patrol_point` calls.
- Setting a goal in Goal mode auto-fires `navigation/start` if not running, so a fresh page can drag-to-go without an explicit Start press.
- Yaw values must stay within `[−π, π]`; values outside that range are flagged `GOAL_POINT_UNREACHABLE`.
- The robot does *not* mint a fresh map id on `mapping/stop` — we mint client-side and push via `set_map_id` to keep saves distinct.

## Files

| File | Role |
|---|---|
| [src/ui/components/mapping-page.ts](../src/ui/components/mapping-page.ts) | The whole feature — UI, state machine, command dispatch, server-log parsing |
| [src/ui/scene/slam-scene.ts](../src/ui/scene/slam-scene.ts) | Three.js scene: ground plane, point clouds, robot marker, goal/patrol markers, drag-to-set-pose |
| [src/ui/scene/robot-model.ts](../src/ui/scene/robot-model.ts) | Go2 GLB model with joint-sync from `LowState` |
| [src/workers/slam-worker.ts](../src/workers/slam-worker.ts) | `libslam.wasm` bridge (cloud dequantization) |
| [src/storage/map-pcd-store.ts](../src/storage/map-pcd-store.ts) | IndexedDB CRUD + zip import/export |
| [src/protocol/data-channel.ts](../src/protocol/data-channel.ts) | `requestFile` (download) + `pushFile` (chunked upload) |
| [src/protocol/topics.ts](../src/protocol/topics.ts) | `RTC_TOPIC.USLAM_*` constants |


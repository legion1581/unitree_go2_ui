# LiDAR / Voxel Map — Unitree Go2

The control view renders the Go2's LiDAR output as a live 3D voxel map (SLAM). Compressed voxel packets arrive over WebRTC, are decoded off the UI thread by a WASM kernel, and displayed as a triangle mesh in Three.js alongside the 3D robot model.

## Table of Contents

- [Topics](#topics)
- [Enable / Disable](#enable--disable)
- [Data Flow](#data-flow)
- [Compressed Packet Format](#compressed-packet-format)
- [WASM Decoder (`libvoxel.wasm`)](#wasm-decoder-libvoxelwasm)
- [Rendering Pipeline](#rendering-pipeline)
- [Robot Radar Animation](#robot-radar-animation)
- [Performance](#performance)
- [Files](#files)

---

## Topics

All LiDAR traffic travels on the WebRTC DataChannel under the `rt/utlidar/*` namespace.

| Topic | Direction | Purpose |
|---|---|---|
| `rt/utlidar/switch` | client → robot | `'ON'` / `'OFF'` string toggles the LiDAR stream |
| `rt/utlidar/voxel_map_compressed` | robot → client | Compressed voxel map frames (ArrayBuffer) |
| `rt/utlidar/lidar_state` | robot → client | LiDAR health/status metadata (human-readable string) |
| `rt/utlidar/robot_pose` | robot → client | Robot odometry used as map origin |

Constants are defined in [src/protocol/topics.ts](../src/protocol/topics.ts) (`RTC_TOPIC.LIDAR_ARRAY`, `LIDAR_STATE`, `ROBOT_ODOM`). Subscription happens in `App.enableVideoAndSubscribe()`.

---

## Enable / Disable

The LiDAR has to be explicitly powered up — it doesn't stream by default.

**Enable:** `setLidarToggle(true)` publishes the string `"ON"` to `rt/utlidar/switch` **five times at 100 ms intervals** (firmware occasionally drops the first packet; the repeat is a reliability fix) and starts the radar spinning animation on the 3D model.

**Disable:** publishes `"OFF"` once, stops the radar spin, and clears the voxel map via `voxelMap.clear()`.

The toggle is surfaced via the LiDAR icon in the control view's setting bar (between Radar and Volume). The state is **not** persisted across reconnects — each WebRTC session starts with LiDAR off.

---

## Data Flow

```
Robot LiDAR
   └─► WebRTC DataChannel (rt/utlidar/voxel_map_compressed)
        └─► DataChannelHandler (onmessage)
             └─► VoxelMap.update(ArrayBuffer, origin, resolution)
                  └─► voxel-worker (postMessage)  [off main thread]
                       └─► libvoxel.wasm._generate(...)
                            ├─► positions  (Uint8Array)
                            ├─► uvs        (Uint8Array)
                            └─► indices    (Uint32Array)
                  └─► Three.js BufferGeometry + MeshBasicMaterial
                       └─► scene.add(mesh)
```

Each incoming frame creates a fresh mesh. The previous mesh is disposed so the map effectively "replaces" on every successful decode.

---

## Compressed Packet Format

What JavaScript hands to the decoder (alongside the raw bytes from the WebRTC message):

```ts
{
  data: ArrayBuffer;         // LZ4-compressed voxel blob
  resolution: number;        // voxel cell size in meters (e.g. 0.1)
  origin: [number, number, number]; // world offset for the map
}
```

`resolution` and `origin` come from sibling fields in the envelope. `origin` updates as the robot moves, so the mesh stays in world coordinates each frame.

### Compression: LZ4 block format

The payload is **LZ4 block format**. The uncompressed size is provided out-of-band in the packet envelope (`src_size`), so the decoder is a direct call to `LZ4_decompress_safe(src, dst, srcSize, dstCapacity)`. No LZ4 frame header — each packet is a standalone block.

Equivalent Python reference (useful for a standalone decoder):

```python
import lz4.block
decompressed = lz4.block.decompress(compressed_data, uncompressed_size=src_size)
```

Our WASM kernel [`public/libvoxel.wasm`](../public/libvoxel.wasm) (9 520 bytes) embeds the LZ4 decoder alongside the geometry generator, so JS only exchanges opaque pointers with it.

### Decompressed payload layout — 3D occupancy bitfield

After LZ4 decompress, the buffer is a flat `uint8[]` array interpreted as a **3D occupancy grid**, bit-packed along the X axis, 128×128×Z voxels per map.

**Per-byte addressing** (exactly as implemented in the Python reference):

```
byte_index → (x, y, z):
  z      = byte_index // 0x800            # 0x800 = 2048 bytes per Z slice
  n      = byte_index %  0x800
  y      = n // 0x10                      # 0x10 = 16 bytes per Y row
  x_base = (n %  0x10) * 8
  # within the byte, bit 7 (MSB) = +0, bit 0 (LSB) = +7
  for bit in 0..7:
      if byte & (1 << (7 - bit)):
          emit voxel at (x_base + bit, y, z)
```

**Dimensions:**

| Axis | Extent | Why |
|---|---|---|
| X | 128 | `16 bytes per row × 8 bits` |
| Y | 128 | `0x800 / 0x10 = 128 rows per slice` |
| Z | variable | `decompressed_size / 0x800` slices — grows with map height |

**Bit convention:** MSB-first within each byte (`bit 0 (MSB) = x_base+0`, `bit 7 (LSB) = x_base+7`). A set bit = the voxel at that grid cell is **occupied** (hit by the LiDAR).

**Grid → world conversion** (same formula as the Python `bits_to_points`):

```
world_xyz = grid_xyz * resolution + origin
```

- `resolution` is typically `0.05 m` or `0.1 m` per voxel (depends on firmware config — the frontend just uses what the envelope provides)
- `origin` is the world-space corner of the grid, updated as the robot moves

### From occupancy bits to renderable geometry

The WASM kernel walks the occupancy bitfield and emits one quad per occupied voxel (face-per-voxel, not merged). For each face it writes:

- 4 vertices × 3 `uint8` grid coords (scaled client-side by `resolution`)
- 4 vertices × 2 `uint8` UV coords for the height-gradient texture lookup
- 6 `uint32` indices (two triangles per quad)

Plus a scalar `zNormalized` per vertex used by the kernel to drive the UV row (so color encodes height).

### Output geometry buffers (kernel → worker → main thread)

For a packet with `faceCount = N`:

| Buffer | Size bytes | Layout |
|---|---|---|
| `positions` | `N × 12` | 4 verts/face × 3 coords × **uint8** (grid-space, scale by `resolution`) |
| `uvs` | `N × 8` | 4 verts/face × 2 coords × **uint8** (2D texture lookup) |
| `indices` | `N × 24` | 6 indices/face × **uint32** (2 triangles, 3 indices each) |

So each `face` = one voxel wall quad (4 vertices, 2 triangles). Max packet size supported: **240,000 faces** per frame (set by the `_malloc` capacities in [voxel-worker.ts:31-38](../src/workers/voxel-worker.ts#L31-L38) — `2,880,000 / 12 = 240k`).

Per-face WASM wall-clock on the worker thread is sub-millisecond at typical packet sizes; throttling (see [Performance](#performance)) caps the main-thread geometry rebuild at ~6.7 Hz.

---

## WASM Decoder (`libvoxel.wasm`)

**Location:** [public/libvoxel.wasm](../public/libvoxel.wasm) (loaded by fetch inside the worker)

**Loader:** [src/workers/voxel-worker.ts](../src/workers/voxel-worker.ts) — a standard dedicated Web Worker that instantiates the module with Emscripten-style imports (memcpy, heap resize).

**Exports:**

| Symbol | Signature | Role |
|---|---|---|
| `_generate` | `(inputPtr, inputLen, decompressBufferSize, decompressBuffer, decompressedSize, positions, uvs, indices, faceCount, pointCount, zNormalized) → void` | Main kernel: decompresses + emits triangulated geometry |
| `_malloc` | `(size) → ptr` | Allocate inside WASM linear memory |
| `_free` | `(ptr) → void` | Release allocation |
| `c` | `WebAssembly.Memory` | Shared linear memory (read back as `Uint8Array`/`Uint32Array` views to extract output arrays) |

The output arrays are produced inside WASM memory; the worker copies them into typed arrays and `postMessage`'s the result back to the main thread (transferring the ArrayBuffers to avoid a copy).

---

## Rendering Pipeline

Implemented in [src/ui/scene/voxel-map.ts](../src/ui/scene/voxel-map.ts).

- **Geometry:** `THREE.BufferGeometry` with:
  - `position` attribute — `Uint8Array`, 3 components per vertex (voxel-grid coords)
  - `uv` attribute — `Uint8Array`, 2 components
  - `index` — `Uint32Array`
- **Material:** `THREE.MeshBasicMaterial` (no lighting — the color is already baked) with a `NearestFilter` texture at [public/models/axisColor4.png](../public/models/axisColor4.png).
- **Coloring:** height-based via UV lookup. The WASM kernel computes a normalized Z per vertex and writes it into the UV so the texture pixel at that row gives the final color. Swapping the texture changes the palette.
- **Transform:** the mesh is scaled by `resolution` and translated to `origin`, so the visualization sits in the same world space as the Go2 model.
- **Culling:** `frustumCulled = false` — the map can be very wide and camera-frustum tests have falsely clipped large meshes before.

The voxel map and robot model share the same Scene3D instance; the PIP-swap feature just toggles which one is "featured" vs "thumbnail".

---

## Robot Radar Animation

A dummy skeletal bone named `RadarBone` in the Go2 GLTF rotates **1 full revolution per second** while LiDAR is on. Implemented in [src/ui/scene/robot-model.ts](../src/ui/scene/robot-model.ts) via `requestAnimationFrame`. The spin is purely cosmetic — there's no physical LiDAR position in the model; it mirrors the APK's "radar is active" visual cue.

`setRadarSpinning(enabled)` is called from the same LiDAR toggle handler so the animation stays in sync with the actual stream.

---

## Performance

| Aspect | Detail |
|---|---|
| Worker thread | Single dedicated worker — WASM decode off the UI thread, main thread only rebuilds the Three.js BufferGeometry |
| Throttle | `VoxelMap.update()` coalesces at 150 ms — if packets arrive faster, only the latest queued payload is processed. Older ones are discarded so the map never lags |
| Transfers | Typed-array buffers are sent via `postMessage` with `transfer: [...]` (zero-copy ownership handoff) |
| Allocation | Each decode allocates a fresh `BufferGeometry`. The previous mesh is disposed (material kept, it's reusable) so memory stays flat |
| GC pressure | High-rate voxel frames can spike if `resolution` is too small or the world is huge — typical rates (~5-10 Hz post-throttle) work well |

The mesh is **not** instanced; the decoder outputs cube-face triangles directly for each occupied voxel in a single draw call.

---

## Files

| File | Role |
|---|---|
| [src/ui/app.ts](../src/ui/app.ts) | Subscription + toggle wiring; routes topic payloads to `VoxelMap` |
| [src/ui/scene/voxel-map.ts](../src/ui/scene/voxel-map.ts) | `VoxelMap` class: worker owner, mesh builder, throttle, clear |
| [src/workers/voxel-worker.ts](../src/workers/voxel-worker.ts) | Web Worker: loads `libvoxel.wasm`, runs `_generate`, posts back typed arrays |
| [public/libvoxel.wasm](../public/libvoxel.wasm) | Emscripten-compiled decoder (opaque binary) |
| [public/models/axisColor4.png](../public/models/axisColor4.png) | Height-gradient lookup texture |
| [src/ui/scene/robot-model.ts](../src/ui/scene/robot-model.ts) | Go2 GLTF model, `RadarBone` spin |
| [src/ui/scene/scene.ts](../src/ui/scene/scene.ts) | Three.js scene owner (shared by robot + voxel map) |
| [src/protocol/topics.ts](../src/protocol/topics.ts) | `RTC_TOPIC.LIDAR_ARRAY` / `LIDAR_STATE` / `ROBOT_ODOM` string constants |
| [src/protocol/data-channel.ts](../src/protocol/data-channel.ts) | `subscribe(topic)` / `publish(topic, data)` helpers |

---

## Quick Reference

| Item | Value |
|---|---|
| Topic (data) | `rt/utlidar/voxel_map_compressed` |
| Topic (state) | `rt/utlidar/lidar_state` |
| Topic (pose) | `rt/utlidar/robot_pose` |
| Topic (toggle) | `rt/utlidar/switch` (payload: `"ON"` / `"OFF"`) |
| Toggle reliability | `"ON"` sent 5× at 100 ms |
| WASM kernel | `_generate(...)` in `libvoxel.wasm` |
| Throttle | 150 ms (coalesces) |
| Radar spin | 1 rev/s |
| Default resolution | 0.1 m per voxel |

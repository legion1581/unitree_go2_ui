/**
 * Web Worker that loads libvoxel.wasm and decompresses voxel_map_compressed data.
 * Input:  { data: ArrayBuffer, resolution: number, origin: [x,y,z], width: [x,y,z] }
 * Output: { geometryData: { point_count, face_count, positions, uvs, indices }, resolution, origin }
 */

interface WasmModule {
  _generate: (...args: number[]) => void;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  getValue: (ptr: number, type: string) => number;
  memory: WebAssembly.Memory;
}

class VoxelDecompressor {
  private mod: WasmModule;
  private _input: number;
  private _decompressBuffer: number;
  private _positions: number;
  private _uvs: number;
  private _indices: number;
  private _decompressedSize: number;
  private _faceCount: number;
  private _pointCount: number;
  private _decompressBufferSize: number;

  constructor(mod: WasmModule, decompressBufferSize: number) {
    this.mod = mod;
    this._input = mod._malloc(61440);
    this._decompressBuffer = mod._malloc(80000);
    this._positions = mod._malloc(2880000);
    this._uvs = mod._malloc(1920000);
    this._indices = mod._malloc(5760000);
    this._decompressedSize = mod._malloc(4);
    this._faceCount = mod._malloc(4);
    this._pointCount = mod._malloc(4);
    this._decompressBufferSize = decompressBufferSize;
  }

  generate(data: Uint8Array, zNormalized: number) {
    // Refresh HEAPU8 in case memory was grown
    this.mod.HEAPU8 = new Uint8Array(this.mod.memory.buffer);

    this.mod.HEAPU8.set(data, this._input);

    this.mod._generate(
      this._input,
      data.length,
      this._decompressBufferSize,
      this._decompressBuffer,
      this._decompressedSize,
      this._positions,
      this._uvs,
      this._indices,
      this._faceCount,
      this._pointCount,
      zNormalized,
    );

    // Refresh view again after _generate (may have grown memory)
    this.mod.HEAPU8 = new Uint8Array(this.mod.memory.buffer);

    const pointCount = this.mod.getValue(this._pointCount, 'i32');
    const faceCount = this.mod.getValue(this._faceCount, 'i32');

    const positions = new Uint8Array(
      this.mod.HEAPU8.subarray(this._positions, this._positions + faceCount * 12).slice(),
    );
    const uvs = new Uint8Array(
      this.mod.HEAPU8.subarray(this._uvs, this._uvs + faceCount * 8).slice(),
    );
    const indices = new Uint32Array(
      this.mod.HEAPU8.subarray(this._indices, this._indices + faceCount * 24).slice().buffer,
    );

    return { point_count: pointCount, face_count: faceCount, positions, uvs, indices };
  }
}

// Load WASM module
let decompressor: VoxelDecompressor | null = null;

async function initWasm(): Promise<void> {
  try {
    const response = await fetch('/libvoxel.wasm');
    const wasmBytes = await response.arrayBuffer();

    // We need a mutable reference to the WASM memory for the import callbacks.
    // The WASM module exports its own memory as 'c', which we capture after instantiation.
    let wasmHeapU8: Uint8Array | null = null;

    const importObj = {
      a: {
        // emscripten_memcpy_js (import 'b')
        b: (dest: number, src: number, num: number) => {
          if (wasmHeapU8) {
            wasmHeapU8.copyWithin(dest, src, src + num);
          }
        },
        // emscripten_resize_heap (import 'a')
        a: () => {
          // Return 0 to indicate failure — shouldn't be needed with sufficient initial memory
          return 0;
        },
      },
    };

    const result = await WebAssembly.instantiate(wasmBytes, importObj);
    const exports = result.instance.exports as Record<string, unknown>;

    // The WASM exports its own memory as 'c'
    const wasmMemory = exports.c as WebAssembly.Memory;
    wasmHeapU8 = new Uint8Array(wasmMemory.buffer);

    // Run __wasm_call_ctors if present (export 'd')
    const ctors = exports.d as (() => void) | undefined;
    if (ctors) ctors();

    const mod: WasmModule = {
      _generate: exports.e as (...args: number[]) => void,
      _malloc: exports.f as (size: number) => number,
      _free: exports.g as (ptr: number) => void,
      HEAPU8: wasmHeapU8,
      memory: wasmMemory,
      getValue: (ptr: number, type: string) => {
        const buf = wasmMemory.buffer;
        switch (type) {
          case 'i32': return new Int32Array(buf)[ptr >> 2];
          case 'i16': return new Int16Array(buf)[ptr >> 1];
          case 'i8': return new Int8Array(buf)[ptr];
          case 'float': return new Float32Array(buf)[ptr >> 2];
          case 'double': return new Float64Array(buf)[ptr >> 3];
          default: return new Int32Array(buf)[ptr >> 2];
        }
      },
    };

    decompressor = new VoxelDecompressor(mod, 80000);
    console.log('[go2:voxel-worker] WASM loaded, decompressor ready');
  } catch (err) {
    console.error('[go2:voxel-worker] Failed to load WASM:', err);
  }
}

initWasm();

const ctx = self as unknown as Worker;

ctx.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!decompressor) return;

  const rawData = msg.data;
  if (!rawData) return;

  const data = new Uint8Array(rawData instanceof ArrayBuffer ? rawData : rawData.buffer || rawData);
  const resolution = Number(msg.resolution) || 0.1;
  const origin = msg.origin as number[];
  if (!origin || origin.length < 3) return;

  const zNormalized = Math.floor(origin[2] / resolution);

  try {
    const geometryData = decompressor.generate(data, zNormalized);
    if (geometryData.face_count > 0) {
      ctx.postMessage({ geometryData, resolution, origin });
    }
  } catch {
    // decompression failed silently
  }
});

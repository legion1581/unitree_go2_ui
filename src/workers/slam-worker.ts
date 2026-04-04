/**
 * Web Worker for SLAM point cloud processing using libvoxel.wasm.
 * Mirrors the APK's three.worker-4tXjtm4c.js logic exactly.
 *
 * Input messages:
 *   { type: "newMap", data: { xmin, xmax, ymin, ymax, zmin, zmax, data: ArrayBuffer } }
 *   "clear"
 *
 * Output messages:
 *   { type: "newMap", data: { output: Float32Array, directOutput: Float32Array, outputCount, directCount } }
 */

interface SlamWasmModule {
  _generate: (...args: number[]) => void;
  _reset: () => void;
  _malloc: (size: number) => number;
  _free: (size: number) => void;
  HEAPU8: Uint8Array;
  getValue: (ptr: number, type: string) => number;
  memory: WebAssembly.Memory;
}

const MAX_POINTS = 1_000_000;

class SlamProcessor {
  private mod: SlamWasmModule;
  private _input: number;
  private _directOutput: number;
  private _outputCount: number;
  private _addedCount: number;
  private _outputDict: number;
  private _outputIndices: number;
  private _output: number;

  constructor(mod: SlamWasmModule) {
    this.mod = mod;
    this._input = mod._malloc(200_000);
    this._directOutput = mod._malloc(300_000);
    this._outputCount = mod._malloc(4);
    this._addedCount = mod._malloc(4);
    this._outputDict = mod._malloc(67_108_864); // 64MB voxel dictionary
    this._outputIndices = mod._malloc(MAX_POINTS * 4);
    this._output = mod._malloc(MAX_POINTS * 12); // 12 bytes per point (3 × Float32)
  }

  clear(): void {
    this.mod.HEAPU8.fill(0, this._outputDict, this._outputDict + 67_108_864);
    this.mod.HEAPU8.fill(0, this._outputIndices, this._outputIndices + MAX_POINTS * 4);
    this.mod._reset();
  }

  generate(
    xmin: number, xmax: number,
    ymin: number, ymax: number,
    zmin: number, zmax: number,
    inputData: Uint8Array,
  ): { output: Float32Array; directOutput: Float32Array; outputCount: number; directCount: number } {
    this.mod.HEAPU8.set(inputData, this._input);
    const numPoints = Math.floor(inputData.length / 6);

    this.mod._generate(
      xmin, xmax, ymin, ymax, zmin, zmax,
      numPoints,
      this._input,
      MAX_POINTS,
      this._outputDict,
      this._outputIndices,
      this._directOutput,
      this._output,
      this._addedCount,
      this._outputCount,
    );

    const outputCount = this.mod.getValue(this._outputCount, 'i32');
    const output = new Float32Array(
      this.mod.HEAPU8.subarray(this._output, this._output + outputCount * 12).slice().buffer,
    );
    const directOutput = new Float32Array(
      this.mod.HEAPU8.subarray(this._directOutput, this._directOutput + numPoints * 12).slice().buffer,
    );

    return { output, directOutput, outputCount, directCount: numPoints };
  }
}

// ── WASM Loading ──

async function loadWasm(): Promise<SlamWasmModule> {
  const wasmUrl = new URL('/libvoxel.wasm', self.location.href).href;
  const imports = {
    a: {
      a: () => { throw new Error('OOM'); },
    },
  };

  const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
  const exports = result.instance.exports;
  const memory = exports.b as WebAssembly.Memory;
  const HEAPU8 = new Uint8Array(memory.buffer);

  const mod: SlamWasmModule = {
    _generate: exports.e as (...args: number[]) => void,
    _reset: exports.d as () => void,
    _malloc: exports.f as (size: number) => number,
    _free: exports.g as (size: number) => void,
    HEAPU8,
    memory,
    getValue: (ptr: number, type: string) => {
      const buf = memory.buffer;
      switch (type) {
        case 'i32': return new Int32Array(buf)[ptr >> 2];
        case 'float': return new Float32Array(buf)[ptr >> 2];
        default: return new Int32Array(buf)[ptr >> 2];
      }
    },
  };

  // Run init
  const initFn = exports.c as () => void;
  if (initFn) initFn();

  return mod;
}

// ── Worker Message Handler ──

let processor: SlamProcessor | null = null;

loadWasm().then((mod) => {
  processor = new SlamProcessor(mod);
  console.log('[slam-worker] WASM loaded, processor ready');
  self.postMessage({ type: 'ready' });
});

self.addEventListener('message', (e: MessageEvent) => {
  if (!processor) return;

  if (e.data === 'clear') {
    processor.clear();
    return;
  }

  const msg = e.data as { type: string; data: Record<string, unknown> };

  if (msg.type === 'newMap') {
    const d = msg.data;
    const result = processor.generate(
      d.xmin as number, d.xmax as number,
      d.ymin as number, d.ymax as number,
      d.zmin as number, d.zmax as number,
      new Uint8Array(d.data as ArrayBuffer),
    );

    self.postMessage({
      type: 'newMap',
      data: result,
    });
  }
});

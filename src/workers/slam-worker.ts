/**
 * Web Worker for SLAM point cloud processing using libvoxel-slam.wasm.
 * Mirrors the APK's three.worker-4tXjtm4c.js logic exactly.
 *
 * APK's WASM (libvoxel-amusQfn9.wasm) export layout:
 *   b = memory
 *   c = __wasm_call_ctors
 *   d = _reset
 *   e = _generate(xmin,xmax,ymin,ymax,zmin,zmax,numPts,input,maxPts,dict,indices,directOut,output,addedCount,outputCount)
 *   f = _malloc
 *   g = _free
 *   Import: a.a = emscripten_resize_heap (1 import only)
 */

const MAX_POINTS = 1_000_000;

interface SlamExports {
  b: WebAssembly.Memory;
  c: () => void;           // __wasm_call_ctors
  d: () => void;           // _reset
  e: (...args: number[]) => void; // _generate
  f: (size: number) => number;    // _malloc
  g: (ptr: number) => void;      // _free
}

class SlamProcessor {
  private exports: SlamExports;
  private heap: Uint8Array;
  private _input: number;
  private _directOutput: number;
  private _outputCount: number;
  private _addedCount: number;
  private _outputDict: number;
  private _outputIndices: number;
  private _output: number;

  constructor(exports: SlamExports) {
    this.exports = exports;
    this.heap = new Uint8Array(exports.b.buffer);

    this._input = exports.f(200_000);
    this._directOutput = exports.f(300_000);
    this._outputCount = exports.f(4);
    this._addedCount = exports.f(4);
    this._outputDict = exports.f(67_108_864);
    this._outputIndices = exports.f(MAX_POINTS * 4);
    this._output = exports.f(MAX_POINTS * 12);
  }

  clear(): void {
    // Refresh heap view in case memory grew
    this.heap = new Uint8Array(this.exports.b.buffer);
    this.heap.fill(0, this._outputDict, this._outputDict + 67_108_864);
    this.heap.fill(0, this._outputIndices, this._outputIndices + MAX_POINTS * 4);
    this.exports.d(); // _reset
  }

  generate(
    xmin: number, xmax: number,
    ymin: number, ymax: number,
    zmin: number, zmax: number,
    inputData: Uint8Array,
  ): { output: Float32Array; directOutput: Float32Array; outputCount: number; directCount: number } {
    // Refresh heap view
    this.heap = new Uint8Array(this.exports.b.buffer);
    this.heap.set(inputData, this._input);

    const numPoints = Math.floor(inputData.length / 6);

    this.exports.e(
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

    // Read results from heap
    const buf = this.exports.b.buffer;
    const outputCount = new Int32Array(buf, this._outputCount, 1)[0];
    const output = new Float32Array(
      buf.slice(this._output, this._output + outputCount * 12),
    );
    const directOutput = new Float32Array(
      buf.slice(this._directOutput, this._directOutput + numPoints * 12),
    );

    return { output, directOutput, outputCount, directCount: numPoints };
  }
}

// ── WASM Loading ──

async function loadWasm(): Promise<SlamProcessor> {
  const wasmUrl = new URL('/libslam.wasm', self.location.href).href;
  const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());

  const imports = {
    a: {
      a: () => 0, // emscripten_resize_heap — only 1 import needed
    },
  };

  const result = await WebAssembly.instantiate(wasmBytes, imports);
  const exports = result.instance.exports as unknown as SlamExports;

  // Run __wasm_call_ctors
  exports.c();

  return new SlamProcessor(exports);
}

// ── Worker Message Handler ──

let processor: SlamProcessor | null = null;

loadWasm().then((p) => {
  processor = p;
  console.log('[slam-worker] WASM loaded, processor ready');
  self.postMessage({ type: 'ready' });
}).catch((err) => {
  console.error('[slam-worker] WASM load failed:', err);
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

    self.postMessage({ type: 'newMap', data: result });
  }
});

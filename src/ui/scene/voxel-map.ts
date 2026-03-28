import * as THREE from 'three';

interface VoxelGeometryData {
  point_count: number;
  face_count: number;
  positions: Uint8Array; // Uint8 voxel grid coords, 3 per vertex (4 verts per face)
  uvs: Uint8Array;       // Uint8 UV coords, 2 per vertex, normalized to [0,1]
  indices: Uint32Array;  // triangle indices (6 per face = 2 triangles per quad)
}

interface VoxelWorkerResult {
  geometryData: VoxelGeometryData;
  resolution: number;
  origin: number[];
}

export class VoxelMap {
  private scene: THREE.Scene;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshBasicMaterial;
  private worker: Worker | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingData: unknown = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // APK: MeshBasicMaterial with axisColor4.png texture, NearestFilter, DoubleSide
    const texture = new THREE.TextureLoader().load('/models/axisColor4.png');
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: false,
    });

    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(
        new URL('../../workers/voxel-worker.ts', import.meta.url),
        { type: 'module' },
      );

      this.worker.onmessage = (e: MessageEvent<VoxelWorkerResult>) => {
        this.applyGeometry(e.data);
      };

      this.worker.onerror = (err) => {
        console.error('[go2:voxel] Worker error:', err);
      };

      console.log('[go2:voxel] Worker initialized');
    } catch (err) {
      console.error('[go2:voxel] Failed to create worker:', err);
    }
  }

  /** Send raw voxel_map_compressed data to the worker for decompression. */
  processCompressed(data: unknown): void {
    if (!this.worker) return;

    // Throttle to 150ms (matching APK)
    this.pendingData = data;
    if (this.throttleTimer) return;

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.pendingData) {
        this.worker!.postMessage(this.pendingData);
        this.pendingData = null;
      }
    }, 150);
  }

  private applyGeometry(result: VoxelWorkerResult): void {
    const { geometryData, resolution, origin } = result;

    if (geometryData.face_count === 0) return;

    // Ensure typed arrays after worker postMessage
    const positions = geometryData.positions instanceof Uint8Array
      ? geometryData.positions
      : new Uint8Array(geometryData.positions as unknown as ArrayBuffer);
    const uvs = geometryData.uvs instanceof Uint8Array
      ? geometryData.uvs
      : new Uint8Array(geometryData.uvs as unknown as ArrayBuffer);
    const indices = geometryData.indices instanceof Uint32Array
      ? geometryData.indices
      : new Uint32Array((geometryData.indices as unknown as Uint8Array).buffer);

    // Remove old mesh
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }

    const geometry = new THREE.BufferGeometry();

    // Positions: Uint8 voxel grid coordinates, 3 components
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // UVs: Uint8, 2 components, normalized to [0,1] — maps into axisColor4.png texture
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2, true));

    // Indices
    if (indices.length > 0) {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    this.mesh = new THREE.Mesh(geometry, this.material);

    // APK: mesh.scale.set(resolution), mesh.position.set(origin)
    this.mesh.scale.set(resolution, resolution, resolution);
    this.mesh.position.set(origin[0], origin[1], origin[2]);
    this.mesh.frustumCulled = false;

    this.scene.add(this.mesh);
  }

  clear(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }

  destroy(): void {
    this.clear();
    this.material.dispose();
    this.worker?.terminate();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
  }
}

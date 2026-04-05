import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';

export type ClickMode = 'none' | 'initial_pose' | 'goal' | 'patrol';

export class SlamScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private animId = 0;

  // Point cloud layers
  private filteredPoints: THREE.Points;
  private laserPoints: THREE.Points;

  // Robot marker
  private robotMarker: THREE.Group;

  // Movement trace
  private tracePositions: number[] = [];
  private traceLine: THREE.Line;

  // Navigation path
  private navPathPoints: THREE.Points | null = null;

  // Patrol waypoints
  private patrolMarkers: THREE.Group[] = [];

  // Click interaction
  private groundPlane: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private clickMode: ClickMode = 'none';
  onMapClick: ((x: number, y: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1a1d23);

    this.scene = new THREE.Scene();

    // Z-up camera — top-down angled view like APK
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -5, 8);

    // Controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI / 2;

    // Lighting
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, -5, 10);
    this.scene.add(dirLight);

    // Grid helper (XY plane, Z-up)
    const grid = new THREE.GridHelper(50, 50, 0x333333, 0x222222);
    grid.rotation.x = Math.PI / 2; // rotate to XY plane
    this.scene.add(grid);

    // Origin axes
    this.scene.add(new THREE.AxesHelper(2));

    // Filtered point cloud (accumulated map — green)
    const filteredGeo = new THREE.BufferGeometry();
    const filteredMat = new THREE.PointsMaterial({ size: 0.03, color: 0x42CF55 });
    this.filteredPoints = new THREE.Points(filteredGeo, filteredMat);
    this.scene.add(this.filteredPoints);

    // Laser point cloud (current scan — white)
    const laserGeo = new THREE.BufferGeometry();
    const laserMat = new THREE.PointsMaterial({ size: 0.05, color: 0xffffff });
    this.laserPoints = new THREE.Points(laserGeo, laserMat);
    this.scene.add(this.laserPoints);

    // Robot marker (arrow shape)
    this.robotMarker = new THREE.Group();
    const arrowShape = new THREE.ConeGeometry(0.15, 0.4, 8);
    arrowShape.rotateX(Math.PI / 2);
    const arrowMesh = new THREE.Mesh(arrowShape, new THREE.MeshStandardMaterial({ color: 0x6879e4 }));
    arrowMesh.position.z = 0.3;
    this.robotMarker.add(arrowMesh);
    const baseMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x6879e4 }),
    );
    baseMesh.position.z = 0.3;
    this.robotMarker.add(baseMesh);
    this.scene.add(this.robotMarker);

    // Movement trace line
    const traceGeo = new THREE.BufferGeometry();
    const traceMat = new THREE.LineBasicMaterial({ color: 0x6879e4, opacity: 0.5, transparent: true });
    this.traceLine = new THREE.Line(traceGeo, traceMat);
    this.scene.add(this.traceLine);

    // Invisible ground plane for raycasting clicks
    const planeGeo = new THREE.PlaneGeometry(200, 200);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    this.groundPlane = new THREE.Mesh(planeGeo, planeMat);
    this.scene.add(this.groundPlane);

    // Click handler
    canvas.addEventListener('pointerdown', (e) => this.handleClick(e));

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  // ── Point Cloud ──

  private pcLogCount = 0;

  updatePointCloud(positions: Float32Array, colors?: Float32Array): void {
    const geo = this.filteredPoints.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (colors) {
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    }
    geo.computeBoundingSphere();
    if (this.pcLogCount < 3) {
      const bs = geo.boundingSphere;
      console.log(`[slam-scene] Filtered points set: ${positions.length / 3} pts, bounds: center(${bs?.center.x.toFixed(2)},${bs?.center.y.toFixed(2)},${bs?.center.z.toFixed(2)}) r=${bs?.radius.toFixed(2)}`);
      this.pcLogCount++;
    }
  }

  updateLaserCloud(positions: Float32Array): void {
    const geo = this.laserPoints.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeBoundingSphere();
  }

  clearPointCloud(): void {
    this.filteredPoints.geometry.dispose();
    this.filteredPoints.geometry = new THREE.BufferGeometry();
    this.laserPoints.geometry.dispose();
    this.laserPoints.geometry = new THREE.BufferGeometry();
  }

  // ── Robot Position ──

  private firstPose = true;

  updateRobotPose(position: { x: number; y: number; z: number }, yaw: number): void {
    this.robotMarker.position.set(position.x, position.y, position.z);
    this.robotMarker.rotation.set(0, 0, yaw);

    // Auto-center camera on robot on first pose
    if (this.firstPose) {
      this.firstPose = false;
      this.controls.target.set(position.x, position.y, 0);
      this.camera.position.set(position.x, position.y - 5, 8);
    }
  }

  // ── Movement Trace ──

  addTracePoint(x: number, y: number, z: number): void {
    this.tracePositions.push(x, y, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.tracePositions, 3));
    this.traceLine.geometry.dispose();
    this.traceLine.geometry = geo;
  }

  clearTrace(): void {
    this.tracePositions = [];
    this.traceLine.geometry.dispose();
    this.traceLine.geometry = new THREE.BufferGeometry();
  }

  // ── Navigation Path ──

  updateNavPath(points: Float32Array): void {
    this.clearNavPath();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.PointsMaterial({ color: 0xff3d3d, size: 0.1 });
    this.navPathPoints = new THREE.Points(geo, mat);
    this.scene.add(this.navPathPoints);
  }

  clearNavPath(): void {
    if (this.navPathPoints) {
      this.scene.remove(this.navPathPoints);
      this.navPathPoints.geometry.dispose();
      this.navPathPoints = null;
    }
  }

  // ── Patrol Waypoints ──

  addPatrolMarker(x: number, y: number, yaw: number, index: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, 0);

    // Sphere marker
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x42CF55 }),
    );
    sphere.position.z = 0.15;
    group.add(sphere);

    // Direction indicator
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.25, 6),
      new THREE.MeshStandardMaterial({ color: 0x42CF55 }),
    );
    arrow.rotation.set(0, 0, yaw);
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(Math.cos(yaw) * 0.25, Math.sin(yaw) * 0.25, 0.15);
    group.add(arrow);

    // Label sprite
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#42CF55';
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${index + 1}`, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
    sprite.scale.set(0.4, 0.4, 1);
    sprite.position.z = 0.5;
    group.add(sprite);

    this.patrolMarkers.push(group);
    this.scene.add(group);
  }

  clearPatrolMarkers(): void {
    for (const m of this.patrolMarkers) {
      this.scene.remove(m);
    }
    this.patrolMarkers = [];
  }

  // ── PCD Loading ──

  private loadedPcd: THREE.Points | null = null;

  loadPCD(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.loadedPcd) {
        this.scene.remove(this.loadedPcd);
        this.loadedPcd.geometry.dispose();
        this.loadedPcd = null;
      }
      const loader = new PCDLoader();
      loader.load(url, (points) => {
        points.material = new THREE.PointsMaterial({ size: 0.03, color: 0xaaaaaa });
        this.loadedPcd = points;
        this.scene.add(points);

        // Center camera on loaded map
        points.geometry.computeBoundingSphere();
        const bs = points.geometry.boundingSphere;
        if (bs) {
          this.controls.target.copy(bs.center);
          this.camera.position.set(bs.center.x, bs.center.y - bs.radius, bs.radius * 1.5);
        }
        resolve();
      }, undefined, reject);
    });
  }

  clearLoadedPcd(): void {
    if (this.loadedPcd) {
      this.scene.remove(this.loadedPcd);
      this.loadedPcd.geometry.dispose();
      this.loadedPcd = null;
    }
  }

  // ── Click Interaction ──

  setClickMode(mode: ClickMode): void {
    this.clickMode = mode;
    this.renderer.domElement.style.cursor = mode === 'none' ? '' : 'crosshair';
  }

  private handleClick(e: PointerEvent): void {
    if (this.clickMode === 'none' || !this.onMapClick) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.groundPlane);
    if (hits.length > 0) {
      const { x, y } = hits[0].point;
      this.onMapClick(x, y);
    }
  }

  // ── Camera ──

  focusOnRobot(): void {
    const pos = this.robotMarker.position;
    this.controls.target.set(pos.x, pos.y, 0);
  }

  // ── Lifecycle ──

  resize(): void {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate(): void {
    this.animId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.controls.dispose();
    this.renderer.dispose();
    window.removeEventListener('resize', () => this.resize());
  }
}

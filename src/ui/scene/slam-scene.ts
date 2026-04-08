import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RobotModel } from './robot-model';

export type ClickMode = 'none' | 'initial_pose' | 'goal' | 'patrol';

/**
 * Custom shader material that colors points by height (Z coordinate).
 * Matches APK's PcdMaterial: R = |sin(z)|, G = 0.5 * |cos(z)|
 */
function createHeightMaterial(size: number): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({ size });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying float heightZ;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4( transformed, 1.0 );
       mvPosition = modelViewMatrix * mvPosition;
       gl_Position = projectionMatrix * mvPosition;
       heightZ = transformed.z;`,
    );
    shader.fragmentShader = 'varying float heightZ;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `vec4 diffuseColor = vec4( diffuse, opacity );
       diffuseColor.r = abs(sin(heightZ / 1.0));
       diffuseColor.g = 0.5 * abs(cos(heightZ / 1.0));
       diffuseColor.b = 0.3;`,
    );
  };
  return mat;
}

export class SlamScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private animId = 0;

  // Point cloud layers
  private filteredPoints: THREE.Points;
  private laserPoints: THREE.Points;

  // Robot marker (Go2 model group)
  private robotMarker: THREE.Group;
  robotVisible = false;
  private go2Model: RobotModel | null = null;

  // Movement trace
  private tracePositions: number[] = [];
  private traceLine: THREE.Line;

  // Navigation path
  private navPathPoints: THREE.Points | null = null;

  // Patrol waypoints
  private patrolMarkers: THREE.Group[] = [];

  // Pose arrow (for initial pose drag-to-set-yaw)
  private poseArrow: THREE.Group | null = null;
  private poseOrigin: { x: number; y: number } | null = null;

  // Click interaction
  private groundPlane: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private clickMode: ClickMode = 'none';
  /** Fires (x, y, yaw) after click+drag release for any pose mode */
  onPoseSet: ((mode: ClickMode, x: number, y: number, yaw: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1a1d23);

    this.scene = new THREE.Scene();

    // Z-up camera
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
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    // Filtered point cloud (accumulated map — height-colored)
    const filteredGeo = new THREE.BufferGeometry();
    this.filteredPoints = new THREE.Points(filteredGeo, createHeightMaterial(0.03));
    this.scene.add(this.filteredPoints);

    // Laser point cloud (current scan — white)
    const laserGeo = new THREE.BufferGeometry();
    const laserMat = new THREE.PointsMaterial({ size: 0.05, color: 0xffffff });
    this.laserPoints = new THREE.Points(laserGeo, laserMat);
    this.scene.add(this.laserPoints);

    // Robot marker group (holds the Go2 model — visible after localization)
    this.robotMarker = new THREE.Group();
    this.robotMarker.visible = false;
    this.scene.add(this.robotMarker);

    // Movement trace line (red like APK)
    const traceGeo = new THREE.BufferGeometry();
    const traceMat = new THREE.LineBasicMaterial({ color: 0xff3d3d });
    this.traceLine = new THREE.Line(traceGeo, traceMat);
    this.scene.add(this.traceLine);

    // Invisible ground plane for raycasting
    const planeGeo = new THREE.PlaneGeometry(200, 200);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    this.groundPlane = new THREE.Mesh(planeGeo, planeMat);
    this.scene.add(this.groundPlane);

    // Load charging station model at origin
    this.loadChargeStation();

    // Interaction handlers
    canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.handlePointerUp(e));

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  // ── Point Cloud ──

  updatePointCloud(positions: Float32Array): void {
    const geo = this.filteredPoints.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeBoundingSphere();
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

    if (this.firstPose) {
      this.firstPose = false;
      this.controls.target.set(position.x, position.y, 0);
      this.camera.position.set(position.x, position.y - 5, 8);
    }
  }

  showRobot(visible: boolean): void {
    this.robotMarker.visible = visible;
    this.robotVisible = visible;
    // Load Go2 model on first show
    if (visible && !this.go2Model) {
      this.go2Model = new RobotModel(this.robotMarker);
    }
  }

  /** Forward motor state to the Go2 model for joint sync */
  updateMotorState(motors: Array<{ q: number }>): void {
    this.go2Model?.updateMotorState(motors);
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

  // ── Navigation Path (red dots like APK) ──

  updateNavPath(points: Float32Array): void {
    this.clearNavPath();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.PointsMaterial({ color: 0xff0000, size: 0.1 });
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

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x42CF55 }),
    );
    sphere.position.z = 0.15;
    group.add(sphere);

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.25, 6),
      new THREE.MeshStandardMaterial({ color: 0x42CF55 }),
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(Math.cos(yaw) * 0.25, Math.sin(yaw) * 0.25, 0.15);
    group.add(arrow);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 64;
    labelCanvas.height = 64;
    const ctx = labelCanvas.getContext('2d')!;
    ctx.fillStyle = '#42CF55';
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${index + 1}`, 32, 32);
    const texture = new THREE.CanvasTexture(labelCanvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
    sprite.scale.set(0.4, 0.4, 1);
    sprite.position.z = 0.5;
    group.add(sprite);

    this.patrolMarkers.push(group);
    this.scene.add(group);
  }

  clearPatrolMarkers(): void {
    for (const m of this.patrolMarkers) this.scene.remove(m);
    this.patrolMarkers = [];
  }

  // ── PCD Loading (height-colored) ──

  private loadedPcd: THREE.Points | null = null;

  loadPCD(data: ArrayBuffer): void {
    this.clearLoadedPcd();
    const loader = new PCDLoader();
    const points = loader.parse(data);
    // Apply height-based coloring like APK
    points.material = createHeightMaterial(0.03);
    this.loadedPcd = points;
    this.scene.add(points);

    points.geometry.computeBoundingSphere();
    const bs = points.geometry.boundingSphere;
    if (bs) {
      this.controls.target.copy(bs.center);
      this.camera.position.set(bs.center.x, bs.center.y - bs.radius, bs.radius * 1.5);
    }
  }

  clearLoadedPcd(): void {
    if (this.loadedPcd) {
      this.scene.remove(this.loadedPcd);
      this.loadedPcd.geometry.dispose();
      this.loadedPcd = null;
    }
  }

  // ── Click/Drag Interaction ──

  setClickMode(mode: ClickMode): void {
    this.clickMode = mode;
    this.renderer.domElement.style.cursor = mode === 'none' ? '' : 'crosshair';
  }

  private getGroundIntersection(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.groundPlane);
    return hits.length > 0 ? hits[0].point : null;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (this.clickMode === 'none') return;
    const pt = this.getGroundIntersection(e);
    if (!pt) return;

    // All modes use click+drag to set position + orientation
    this.poseOrigin = { x: pt.x, y: pt.y };
    this.controls.enabled = false;
    const color = this.clickMode === 'initial_pose' ? 0xff3d3d
      : this.clickMode === 'goal' ? 0xFCD335
      : 0x42CF55; // patrol
    this.createPoseArrow(pt.x, pt.y, color);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.poseOrigin || !this.poseArrow) return;
    const pt = this.getGroundIntersection(e);
    if (!pt) return;

    // Update arrow direction
    const yaw = Math.atan2(pt.y - this.poseOrigin.y, pt.x - this.poseOrigin.x);
    this.poseArrow.rotation.set(0, 0, yaw);
  }

  private handlePointerUp(_e: PointerEvent): void {
    if (!this.poseOrigin || !this.poseArrow) return;

    const yaw = this.poseArrow.rotation.z;
    const { x, y } = this.poseOrigin;
    const mode = this.clickMode;

    // Clean up
    this.scene.remove(this.poseArrow);
    this.poseArrow = null;
    this.poseOrigin = null;
    this.controls.enabled = true;

    // For patrol, keep click mode active for adding multiple points
    if (mode !== 'patrol') {
      this.setClickMode('none');
    }

    // Fire callback with mode
    this.onPoseSet?.(mode, x, y, yaw);
  }

  private createPoseArrow(x: number, y: number, color = 0xff3d3d): void {
    if (this.poseArrow) this.scene.remove(this.poseArrow);

    this.poseArrow = new THREE.Group();
    this.poseArrow.position.set(x, y, 0.05);

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 12, 12),
      new THREE.MeshStandardMaterial({ color }),
    );
    this.poseArrow.add(sphere);

    const arrowCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.15, 0.4, 12),
      new THREE.MeshStandardMaterial({ color }),
    );
    arrowCone.rotation.z = -Math.PI / 2;
    arrowCone.position.x = 0.6;
    this.poseArrow.add(arrowCone);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.4, 0, 0),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
    this.poseArrow.add(line);

    this.scene.add(this.poseArrow);
  }

  // ── Charging Station ──

  private loadChargeStation(): void {
    const loader = new GLTFLoader();
    loader.load('/models/charge.glb', (gltf) => {
      const model = gltf.scene;
      // Match APK: rotate X by PI/2 (Y-up to Z-up), scale 2.5x, at origin
      model.rotateOnAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      model.scale.set(2.5, 2.5, 2.5);
      this.scene.add(model);
    });
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
  }
}

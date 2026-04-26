import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RobotModel } from './robot-model';
import { theme } from '../theme';

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

  // Goal marker
  private goalMarker: THREE.Group | null = null;

  // Pose arrow (for hold-to-place then drag-to-set-yaw)
  private poseArrow: THREE.Group | null = null;
  private poseOrigin: { x: number; y: number } | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdStartPos: { cx: number; cy: number } | null = null;
  private holdPlaced = false;
  private static readonly HOLD_TIME = 600; // ms, matching APK
  private static readonly HOLD_MOVE_THRESHOLD = 4; // px — cancel hold if moved

  // Click interaction
  private groundPlane: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private clickMode: ClickMode = 'none';
  /** Fires (x, y, yaw) after click+drag release for any pose mode */
  onPoseSet: ((mode: ClickMode, x: number, y: number, yaw: number) => void) | null = null;

  // Theme integration: clear color + grid colors react to dark/light toggle.
  private grid: THREE.GridHelper | null = null;
  private unsubTheme: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(theme().colors.background);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(theme().colors.background);

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

    // Grid helper (XY plane, Z-up). Color comes from theme.
    this.rebuildGrid(theme().colors.grid);

    // React to theme toggles: re-clear, re-tint background, rebuild grid,
    // recolor the laser cloud (white on dark bg / blue on light bg).
    this.unsubTheme = theme().onChange((t, colors) => {
      this.renderer.setClearColor(colors.background);
      this.scene.background = new THREE.Color(colors.background);
      this.rebuildGrid(colors.grid);
      const laserColor = t === 'light' ? 0x6879e4 : 0xffffff;
      (this.laserPoints.material as THREE.PointsMaterial).color.setHex(laserColor);
    });

    // Filtered point cloud (accumulated map — height-colored)
    const filteredGeo = new THREE.BufferGeometry();
    this.filteredPoints = new THREE.Points(filteredGeo, createHeightMaterial(0.03));
    this.scene.add(this.filteredPoints);

    // Laser point cloud (current scan). White on dark; blue on light to stay
    // visible against the near-white background.
    const laserGeo = new THREE.BufferGeometry();
    const laserColor = theme().theme === 'light' ? 0x6879e4 : 0xffffff;
    const laserMat = new THREE.PointsMaterial({ size: 0.05, color: laserColor });
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

  /** Clear all visualization: point clouds, trace, markers, PCD */
  clearAll(): void {
    this.clearPointCloud();
    this.clearLoadedPcd();
    this.clearTrace();
    this.clearNavPath();
    this.clearGoalMarker();
    this.clearPatrolMarkers();
  }

  // ── Robot Position ──

  // Pose smoothing — odom updates set a *target*; the animate() loop lerps
  // toward it every frame so the robot moves continuously between samples
  // and absorbs the noise inherent in the SLAM pose estimate.
  private firstPose = true;
  private targetPos = new THREE.Vector3();
  private targetQuat = new THREE.Quaternion();
  // Per-frame interpolation factors. Lower = smoother but more lag.
  private static readonly POS_LERP_PER_FRAME = 0.15;
  private static readonly ROT_LERP_PER_FRAME = 0.15;

  updateRobotPose(position: { x: number; y: number; z: number }, yaw: number): void {
    this.targetPos.set(position.x, position.y, position.z);
    this.targetQuat.setFromEuler(new THREE.Euler(0, 0, yaw));

    if (this.firstPose) {
      this.firstPose = false;
      this.robotMarker.position.copy(this.targetPos);
      this.robotMarker.quaternion.copy(this.targetQuat);
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

  // ── Movement Trace (comet tail — keeps last MAX_TRACE points) ──

  private static readonly MAX_TRACE_POINTS = 200;

  addTracePoint(x: number, y: number, z: number): void {
    this.tracePositions.push(x, y, z);
    // Comet tail: trim oldest points beyond limit
    const max3 = SlamScene.MAX_TRACE_POINTS * 3;
    if (this.tracePositions.length > max3) {
      this.tracePositions.splice(0, this.tracePositions.length - max3);
    }
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

  // ── Waypoint / Goal Markers ──

  /**
   * Create a pole marker: vertical line from ground, arrow on top pointing yaw direction.
   * Optionally shows a numbered label (for patrol waypoints).
   */
  private createPoleMarker(x: number, y: number, yaw: number, color: number, label?: string): THREE.Group {
    const POLE_HEIGHT = 0.8;
    const group = new THREE.Group();
    group.position.set(x, y, 0);

    // Vertical pole (thin cylinder)
    const poleGeo = new THREE.CylinderGeometry(0.02, 0.02, POLE_HEIGHT, 8);
    poleGeo.rotateX(Math.PI / 2); // Y-up to Z-up
    const pole = new THREE.Mesh(poleGeo, new THREE.MeshStandardMaterial({ color }));
    pole.position.z = POLE_HEIGHT / 2;
    group.add(pole);

    // Small base ring on ground
    const ringGeo = new THREE.TorusGeometry(0.12, 0.025, 8, 24);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color }));
    ring.position.z = 0.025;
    group.add(ring);

    // Arrow on top of pole pointing in yaw direction
    const arrowGroup = new THREE.Group();
    arrowGroup.position.z = POLE_HEIGHT;
    arrowGroup.rotation.z = yaw;

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.3, 8),
      new THREE.MeshStandardMaterial({ color }),
    );
    cone.rotation.z = -Math.PI / 2; // Point along +X
    cone.position.x = 0.2;
    arrowGroup.add(cone);

    // Short shaft behind arrow
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.15, 6),
      new THREE.MeshStandardMaterial({ color }),
    );
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = 0.02;
    arrowGroup.add(shaft);

    group.add(arrowGroup);

    // Label sprite (number or text) above arrow
    if (label) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(32, 32, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 32, 32);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
      sprite.scale.set(0.35, 0.35, 1);
      sprite.position.z = POLE_HEIGHT + 0.35;
      group.add(sprite);
    }

    return group;
  }

  addPatrolMarker(x: number, y: number, yaw: number, index: number): void {
    const group = this.createPoleMarker(x, y, yaw, 0x42CF55, `${index + 1}`);
    this.patrolMarkers.push(group);
    this.scene.add(group);
  }

  setGoalMarker(x: number, y: number, yaw: number): void {
    this.clearGoalMarker();
    this.goalMarker = this.createPoleMarker(x, y, yaw, 0xFCD335);
    this.scene.add(this.goalMarker);
  }

  clearGoalMarker(): void {
    if (this.goalMarker) {
      this.scene.remove(this.goalMarker);
      this.goalMarker = null;
    }
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

    // Store screen position for move-threshold check
    this.holdStartPos = { cx: e.clientX, cy: e.clientY };
    this.holdPlaced = false;

    const pt = this.getGroundIntersection(e);
    if (!pt) return;

    const heldX = pt.x;
    const heldY = pt.y;

    // Start 600ms hold timer (matching APK)
    this.cancelHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdPlaced = true;
      this.poseOrigin = { x: heldX, y: heldY };
      this.controls.enabled = false;
      const color = this.clickMode === 'initial_pose' ? 0xff3d3d
        : this.clickMode === 'goal' ? 0xFCD335
        : 0x42CF55; // patrol
      this.createPoseArrow(heldX, heldY, color);
    }, SlamScene.HOLD_TIME);
  }

  private handlePointerMove(e: PointerEvent): void {
    // If hold timer is still running, check if moved too far (cancel = camera pan)
    if (this.holdTimer && this.holdStartPos) {
      const dx = e.clientX - this.holdStartPos.cx;
      const dy = e.clientY - this.holdStartPos.cy;
      if (dx * dx + dy * dy > SlamScene.HOLD_MOVE_THRESHOLD * SlamScene.HOLD_MOVE_THRESHOLD) {
        this.cancelHold();
        return;
      }
    }

    // If point is placed, update arrow direction
    if (!this.poseOrigin || !this.poseArrow) return;
    const pt = this.getGroundIntersection(e);
    if (!pt) return;
    const yaw = Math.atan2(pt.y - this.poseOrigin.y, pt.x - this.poseOrigin.x);
    this.poseArrow.rotation.set(0, 0, yaw);
  }

  private handlePointerUp(_e: PointerEvent): void {
    // Cancel hold timer if still pending
    if (this.holdTimer) {
      this.cancelHold();
      return; // Was a short click, not a hold — do nothing
    }
    this.holdStartPos = null;

    if (!this.holdPlaced || !this.poseOrigin || !this.poseArrow) return;

    const yaw = this.poseArrow.rotation.z;
    const { x, y } = this.poseOrigin;
    const mode = this.clickMode;

    // Clean up
    this.scene.remove(this.poseArrow);
    this.poseArrow = null;
    this.poseOrigin = null;
    this.holdPlaced = false;
    this.controls.enabled = true;

    // Deactivate click mode after placing (user re-activates for next point)
    this.setClickMode('none');

    // Fire callback with mode
    this.onPoseSet?.(mode, x, y, yaw);
  }

  private cancelHold(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holdStartPos = null;
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
      const group = new THREE.Group();

      // Charging station model (half size of previous: 1.25x)
      const model = gltf.scene;
      model.rotateOnAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      model.scale.set(1.25, 1.25, 1.25);
      group.add(model);

      // Vertical pole with "Charging Station" label
      const POLE_H = 1.2;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, POLE_H, 8),
        new THREE.MeshStandardMaterial({ color: 0x6879e4 }),
      );
      pole.rotation.x = Math.PI / 2; // Y-up to Z-up
      pole.position.z = POLE_H / 2;
      group.add(pole);

      // Label sprite
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(26, 29, 35, 0.85)';
      ctx.roundRect(0, 0, 256, 64, 8);
      ctx.fill();
      ctx.strokeStyle = '#6879e4';
      ctx.lineWidth = 2;
      ctx.roundRect(0, 0, 256, 64, 8);
      ctx.stroke();
      ctx.fillStyle = '#6879e4';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Charging Station', 128, 32);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
      sprite.scale.set(1.2, 0.3, 1);
      sprite.position.z = POLE_H + 0.25;
      group.add(sprite);

      this.scene.add(group);
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

    // Smoothly chase the latest odom-driven target every frame. Running this
    // at render rate (60 Hz) absorbs the per-sample jitter from the SLAM pose
    // estimate so the robot model glides instead of jittering on each update.
    if (this.robotMarker.visible && !this.firstPose) {
      this.robotMarker.position.lerp(this.targetPos, SlamScene.POS_LERP_PER_FRAME);
      this.robotMarker.quaternion.slerp(this.targetQuat, SlamScene.ROT_LERP_PER_FRAME);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private rebuildGrid(color: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      const m = this.grid.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) for (const mm of m) mm.dispose(); else m.dispose();
      this.grid.geometry.dispose();
    }
    const g = new THREE.GridHelper(50, 50, color, color);
    g.rotation.x = Math.PI / 2;
    this.scene.add(g);
    this.grid = g;
  }

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.controls.dispose();
    this.renderer.dispose();
    this.unsubTheme?.();
    this.unsubTheme = null;
  }
}

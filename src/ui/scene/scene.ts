import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { RobotModel } from './robot-model';
import { VoxelMap } from './voxel-map';
import { theme } from '../theme';

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  robotModel: RobotModel;
  voxelMap: VoxelMap;
  private animationId: number = 0;
  private grid: THREE.GridHelper | null = null;
  private unsubTheme: () => void = () => {};

  // View toggle state (double-tap)
  private viewType: 'overview' | 'follow' = 'overview';
  private lastTapTime = 0;
  private lastTapX = 0;
  private savedCameraPos = new THREE.Vector3(1, -1, 0.5);
  private savedTarget = new THREE.Vector3(0, 0, 0.15);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    // Theme-aware background (APK dark = 0x282828; light = near-white)
    this.scene.background = new THREE.Color(theme().colors.background);

    // Z-up coordinate system to match Go2 model and APK
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    // Initial view: behind the robot, looking down (overview/holistic)
    this.camera.position.set(0, -3, 5);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 20;
    this.controls.update();

    this.setupLights();
    this.setupGrid();
    this.loadEnvironment();

    this.robotModel = new RobotModel(this.scene);
    this.voxelMap = new VoxelMap(this.scene);

    // Double-tap detection on canvas
    canvas.addEventListener('pointerdown', (e) => this.handleDoubleTap(e));

    // Re-apply background + grid on theme change
    this.unsubTheme = theme().onChange((_t, colors) => {
      this.scene.background = new THREE.Color(colors.background);
      this.rebuildGrid(colors.grid);
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(5, -5, 8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 30;
    dir.shadow.camera.left = -5;
    dir.shadow.camera.right = 5;
    dir.shadow.camera.top = 5;
    dir.shadow.camera.bottom = -5;
    this.scene.add(dir);

    const hemi = new THREE.HemisphereLight(0x8888ff, 0x444422, 0.4);
    this.scene.add(hemi);
  }

  private setupGrid(): void {
    this.rebuildGrid(theme().colors.grid);
  }

  private rebuildGrid(color: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      (this.grid.material as THREE.Material).dispose?.();
      this.grid.geometry.dispose();
    }
    const g = new THREE.GridHelper(40, 40, color, color);
    g.rotateX(Math.PI / 2);
    this.scene.add(g);
    this.grid = g;
  }

  private loadEnvironment(): void {
    new HDRLoader().load('/models/venice_sunset_1k.hdr', (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = texture;
    });
  }

  private handleDoubleTap(e: PointerEvent): void {
    const now = performance.now();
    if (now - this.lastTapTime < 300 && Math.abs(e.clientX - this.lastTapX) <= 60) {
      this.toggleView();
    }
    this.lastTapTime = now;
    this.lastTapX = e.clientX;
  }

  private toggleView(): void {
    if (this.viewType === 'follow') {
      // Switch to overview: zoom out, look down at the map from behind
      this.savedCameraPos.copy(this.camera.position);
      this.savedTarget.copy(this.controls.target);

      const robotPos = this.robotModel.getPosition();
      this.animateCamera(
        new THREE.Vector3(robotPos.x, robotPos.y - 3, robotPos.z + 5),
        new THREE.Vector3(robotPos.x, robotPos.y, robotPos.z),
      );
      this.scene.fog = null;
      this.viewType = 'overview';
    } else {
      // Switch to follow view: close behind the robot
      const robotPos = this.robotModel.getPosition();
      this.animateCamera(
        new THREE.Vector3(robotPos.x + 1, robotPos.y - 1, robotPos.z + 0.5),
        new THREE.Vector3(robotPos.x, robotPos.y, robotPos.z + 0.15),
      );
      this.scene.fog = new THREE.Fog(0x282828, 0.015, 20);
      this.viewType = 'follow';
    }
  }

  private animateCamera(targetPos: THREE.Vector3, targetLookAt: THREE.Vector3): void {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const duration = 500;
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = t * (2 - t); // ease-out
      this.camera.position.lerpVectors(startPos, targetPos, eased);
      this.controls.target.lerpVectors(startTarget, targetLookAt, eased);
      this.controls.update();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

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
    this.animationId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  destroy(): void {
    cancelAnimationFrame(this.animationId);
    this.unsubTheme();
    this.renderer.dispose();
  }
}

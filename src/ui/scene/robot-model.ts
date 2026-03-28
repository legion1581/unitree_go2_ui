import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface Joint {
  bone: THREE.Bone;
  axis: THREE.Vector3;
  initialAngle: number;
  initialQuaternion: THREE.Quaternion;
}

// Motor state from lowstate topic
interface MotorState {
  q: number; // joint angle in radians
}

// Leg order in the motor array: FR, FL, RR, RL
// Each leg has 3 joints: hip, thigh, calf
const LEG_ORDER = ['FR', 'FL', 'RR', 'RL'] as const;
const JOINT_ORDER = ['hip', 'thigh', 'calf'] as const;

// APK applies this Z offset to place the model on the ground plane
const BODY_HEIGHT_OFFSET = -0.3;

export class RobotModel {
  private model: THREE.Group | null = null;
  private scene: THREE.Scene;
  private joints: Map<string, Joint> = new Map();
  private radarAngle = 0;
  private radarAnimId = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.load();
  }

  private async load(): Promise<void> {
    const loader = new GLTFLoader();

    try {
      const gltf = await loader.loadAsync('/models/Go2.glb');
      this.model = gltf.scene;

      // Hide the ExtendRail and Rod (knee linkage) parts
      const rail = this.model.getObjectByName('ExtendRail');
      if (rail) rail.visible = false;
      for (const leg of ['FL', 'FR', 'RL', 'RR']) {
        const rod = this.model.getObjectByName(`Rod${leg}`);
        if (rod) rod.visible = false;
      }

      this.model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          // Make model semi-transparent like APK
          if (child.material) {
            const mat = child.material as THREE.MeshStandardMaterial;
            mat.transparent = true;
            mat.opacity = 0.85;
          }
        }
      });

      // Set initial position with body height offset (places model on ground)
      this.model.position.set(0, 0, BODY_HEIGHT_OFFSET);

      this.scene.add(this.model);
      this.buildJointMap(gltf);
      this.startRadarSpin();
      console.log('[go2:3d] Model loaded, joints:', Array.from(this.joints.keys()));
    } catch (err) {
      console.error('[go2:3d] Failed to load Go2 model:', err);
    }
  }

  private buildJointMap(gltf: { scene: THREE.Group }): void {
    const scene = gltf.scene;

    for (const leg of LEG_ORDER) {
      // Hip: rotation axis X, initial angle 0
      const hipBone = scene.getObjectByName(`HipBone${leg}`) as THREE.Bone | undefined;
      if (hipBone) {
        this.joints.set(`hip${leg}`, {
          bone: hipBone,
          axis: new THREE.Vector3(1, 0, 0),
          initialAngle: 0,
          initialQuaternion: hipBone.quaternion.clone(),
        });
      }

      // Thigh: rotation axis Z, initial angle PI/4
      const thighBone = scene.getObjectByName(`ThighBone${leg}`) as THREE.Bone | undefined;
      if (thighBone) {
        this.joints.set(`thigh${leg}`, {
          bone: thighBone,
          axis: new THREE.Vector3(0, 0, 1),
          initialAngle: Math.PI / 4,
          initialQuaternion: thighBone.quaternion.clone(),
        });
      }

      // Calf: rotation axis Z, initial angle -PI/2
      const calfBone = scene.getObjectByName(`CalfBone${leg}`) as THREE.Bone | undefined;
      if (calfBone) {
        this.joints.set(`calf${leg}`, {
          bone: calfBone,
          axis: new THREE.Vector3(0, 0, 1),
          initialAngle: -Math.PI / 2,
          initialQuaternion: calfBone.quaternion.clone(),
        });
      }
    }

    // Radar bone
    const radarBone = scene.getObjectByName('RadarBone') as THREE.Bone | undefined;
    if (radarBone) {
      this.joints.set('radar', {
        bone: radarBone,
        axis: new THREE.Vector3(0, -1, 0),
        initialAngle: 0,
        initialQuaternion: radarBone.quaternion.clone(),
      });
    }
  }

  private setJointAngle(name: string, angle: number): void {
    const joint = this.joints.get(name);
    if (!joint) return;

    const q = new THREE.Quaternion();
    q.setFromAxisAngle(joint.axis, angle - joint.initialAngle);
    q.premultiply(joint.initialQuaternion);
    joint.bone.quaternion.copy(q);
  }

  /**
   * Update all motor joint angles from lowstate data.
   * Motor array: [FR_hip, FR_thigh, FR_calf, FL_hip, FL_thigh, FL_calf,
   *               RR_hip, RR_thigh, RR_calf, RL_hip, RL_thigh, RL_calf]
   */
  updateMotorState(motors: MotorState[]): void {
    if (!this.model || motors.length < 12) return;

    for (let legIdx = 0; legIdx < 4; legIdx++) {
      const leg = LEG_ORDER[legIdx];
      for (let jointIdx = 0; jointIdx < 3; jointIdx++) {
        const motor = motors[legIdx * 3 + jointIdx];
        if (motor && typeof motor.q === 'number') {
          this.setJointAngle(`${JOINT_ORDER[jointIdx]}${leg}`, motor.q);
        }
      }
    }
  }

  /**
   * Update robot position from odometry data.
   */
  updateOdom(position: { x: number; y: number; z: number },
             orientation: { x: number; y: number; z: number; w: number }): void {
    if (!this.model) return;
    this.model.position.set(position.x, position.y, position.z + BODY_HEIGHT_OFFSET);
    const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    const euler = new THREE.Euler().setFromQuaternion(q);
    this.model.rotation.set(euler.x, euler.y, euler.z);
  }

  /** Continuously spin the lidar/radar bone like the APK does. */
  private startRadarSpin(): void {
    if (this.radarAnimId) return;
    const SPEED = Math.PI * 2; // 1 full rotation per second
    let lastTime = performance.now();

    const spin = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.radarAngle += SPEED * dt;
      this.setJointAngle('radar', this.radarAngle);
      this.radarAnimId = requestAnimationFrame(spin);
    };
    this.radarAnimId = requestAnimationFrame(spin);
  }

  private stopRadarSpin(): void {
    if (this.radarAnimId) {
      cancelAnimationFrame(this.radarAnimId);
      this.radarAnimId = 0;
    }
  }

  setRadarSpinning(spinning: boolean): void {
    if (spinning) {
      this.startRadarSpin();
    } else {
      this.stopRadarSpin();
    }
  }

  /** Hide a named mesh/object in the model (e.g. 'RodFL', 'ExtendRail'). */
  setPartVisible(name: string, visible: boolean): void {
    if (!this.model) return;
    const obj = this.model.getObjectByName(name);
    if (obj) obj.visible = visible;
  }

  /** Hide all Rod meshes (knee linkage pieces). */
  hideRods(): void {
    for (const leg of ['FL', 'FR', 'RL', 'RR']) {
      this.setPartVisible(`Rod${leg}`, false);
    }
  }

  getModel(): THREE.Group | null {
    return this.model;
  }

  getPosition(): THREE.Vector3 {
    return this.model?.position.clone() ?? new THREE.Vector3(0, 0, 0);
  }

  destroy(): void {
    this.stopRadarSpin();
  }
}

import type { ConnectionCallbacks, ConnectionConfig, ConnectionState, DataChannelMessage } from '../types';
import { ConnectionPanel } from './connection-panel';
import { Joystick } from './components/joystick';
import { NavBar } from './components/status-bar';
import { ActionBar } from './components/action-bar';
import { PipCamera } from './components/pip-camera';
import { SettingBar, EmergencyStop } from './components/side-buttons';
import { StatusPage } from './components/status-page';
import { ServicesPage, type ServiceEntry } from './components/services-page';
import { MappingPage } from './components/mapping-page';
import { connectLocal } from '../connection/local-connector';
import { connectRemote, loginWithEmail } from '../connection/remote-connector';
import { DataChannelHandler } from '../protocol/data-channel';
import { RTC_TOPIC, SPORT_CMD, DATA_CHANNEL_TYPE } from '../protocol/topics';
import type { WebRTCConnection } from '../connection/webrtc';
import type { Scene3D } from './scene/scene';

type Screen = 'connection' | 'hub' | 'control' | 'status' | 'services' | 'mapping';

export class App {
  private root: HTMLElement;
  private currentScreen: Screen = 'connection';

  // Connection state (persists across screens)
  private connectionPanel: ConnectionPanel | null = null;
  private webrtc: WebRTCConnection | null = null;
  private dataHandler: DataChannelHandler | null = null;
  private videoStream: MediaStream | null = null;
  private connectionConfig: ConnectionConfig | null = null;

  // Control UI components
  private navBar: NavBar | null = null;
  private pipCamera: PipCamera | null = null;
  private controlUi: HTMLElement | null = null;
  private actionBar: ActionBar | null = null;
  private scene3d: Scene3D | null = null;
  private settingBar: SettingBar | null = null;

  // Status page
  private statusPage: StatusPage | null = null;

  // Services page
  private servicesPage: ServicesPage | null = null;
  private mappingPage: MappingPage | null = null;
  private serviceEntries: ServiceEntry[] = [];
  private serviceReportTimer: ReturnType<typeof setInterval> | null = null;

  // Joystick state
  private joystickState = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private joystickTimer: ReturnType<typeof setInterval> | null = null;

  // Robot state (accumulated from topic messages)
  private robotState = {
    batteryPercent: 0,
    batteryCurrent: 0,
    batteryVoltage: 0,
    batteryCycles: 0,
    batteryTemp: 0,
    motorStates: [] as Array<{ q: number; dq: number; tau: number; temp: number; lost: number }>,
    networkType: '',
    footForce: [] as number[],
    imuTemp: 0,
    mode: 0,
    gaitType: 0,
    position: [0, 0, 0] as number[],
    velocity: [0, 0, 0] as number[],
    // Firmware / version info (from bashrunner)
    firmwareVersion: '',
    // Motion switcher
    motionMode: '',
    // LiDAR state
    lidarState: '' as string,
    // Self-test results
    selfTestResults: [] as string[],
  };

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = '';
    root.className = 'app-root';
    this.showConnectionScreen();
  }

  // ── Screen Navigation ──

  private showConnectionScreen(): void {
    this.currentScreen = 'connection';
    this.root.innerHTML = '';
    this.root.className = 'app-root connection-screen';

    const modal = document.createElement('div');
    modal.className = 'connection-modal';
    this.root.appendChild(modal);

    this.connectionPanel = new ConnectionPanel(modal, (config) => this.connect(config));
  }

  private showHubScreen(): void {
    this.currentScreen = 'hub';
    this.root.innerHTML = '';
    this.root.className = 'app-root hub-screen';

    const hub = document.createElement('div');
    hub.className = 'hub-container';

    // Title
    const title = document.createElement('h2');
    title.className = 'hub-title';
    title.textContent = 'Go2 Connected';
    hub.appendChild(title);

    // Connection info
    const info = document.createElement('div');
    info.className = 'hub-info';
    info.textContent = `IP: ${this.connectionConfig?.ip || 'N/A'} | Mode: ${this.connectionConfig?.mode || 'N/A'}`;
    hub.appendChild(info);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'hub-buttons';

    // WebView (Control UI) button
    const controlBtn = document.createElement('button');
    controlBtn.className = 'hub-btn hub-btn-primary';
    controlBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg><span>WebView</span>`;
    controlBtn.addEventListener('click', () => this.showControlUi());
    btnRow.appendChild(controlBtn);

    // Status button
    const statusBtn = document.createElement('button');
    statusBtn.className = 'hub-btn hub-btn-secondary';
    statusBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg><span>Status</span>`;
    statusBtn.addEventListener('click', () => this.showStatusScreen());
    btnRow.appendChild(statusBtn);

    // Services button
    const svcBtn = document.createElement('button');
    svcBtn.className = 'hub-btn hub-btn-secondary';
    svcBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg><span>Services</span>`;
    svcBtn.addEventListener('click', () => this.showServicesScreen());
    btnRow.appendChild(svcBtn);

    // 3D LiDAR Mapping button
    const mapBtn = document.createElement('button');
    mapBtn.className = 'hub-btn hub-btn-secondary';
    mapBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg><span>Mapping</span>`;
    mapBtn.addEventListener('click', () => this.showMappingScreen());
    btnRow.appendChild(mapBtn);

    hub.appendChild(btnRow);

    // Disconnect button
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'hub-btn-disconnect';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', () => this.disconnect());
    hub.appendChild(disconnectBtn);

    this.root.appendChild(hub);
  }

  private showControlUi(): void {
    this.currentScreen = 'control';
    this.root.innerHTML = '';
    this.root.className = 'app-root control-screen';

    // Overlay container
    this.controlUi = document.createElement('div');
    this.controlUi.className = 'control-overlay';
    this.root.appendChild(this.controlUi);

    this.init3DScene();

    // Nav bar (top) — back goes to hub, not disconnect
    this.navBar = new NavBar(this.controlUi, () => this.goToHub());

    // PIP camera
    this.pipCamera = new PipCamera(this.controlUi);
    if (this.videoStream) {
      this.pipCamera.setStream(this.videoStream);
    }
    this.pipCamera.setOnTap(() => this.toggleViewMode());

    // Setting bar
    this.settingBar = new SettingBar(this.controlUi, {
      onRadarToggle: (enabled) => this.sendRadarToggle(enabled),
      onLidarToggle: (enabled) => this.sendLidarToggle(enabled),
      onLampSet: (level) => this.sendLamp(level),
      onVolumeSet: (level) => this.sendVolume(level),
    });

    // Emergency stop
    new EmergencyStop(this.controlUi, (active) => this.sendStop(active));

    // Operation layout
    const opWrapper = document.createElement('div');
    opWrapper.className = 'operation-wrapper';

    const w1 = document.createElement('div');
    w1.className = 'wrapper-1';
    new Joystick(w1, (out) => {
      this.joystickState.lx = out.x;
      this.joystickState.ly = out.y;
    }, () => {
      this.joystickState.lx = 0;
      this.joystickState.ly = 0;
    });
    opWrapper.appendChild(w1);

    const w2 = document.createElement('div');
    w2.className = 'wrapper-2';
    this.actionBar = new ActionBar(w2, (action) => {
      this.dataHandler?.publishRequest(RTC_TOPIC.SPORT_MOD, action.apiId, action.param);
    });
    opWrapper.appendChild(w2);

    const w3 = document.createElement('div');
    w3.className = 'wrapper-3';
    new Joystick(w3, (out) => {
      this.joystickState.rx = out.x;
      this.joystickState.ry = out.y;
    }, () => {
      this.joystickState.rx = 0;
      this.joystickState.ry = 0;
    });
    opWrapper.appendChild(w3);

    this.controlUi.appendChild(opWrapper);

    this.startJoystickLoop();

    // Re-apply current battery / network state
    if (this.robotState.batteryPercent > 0) {
      this.navBar?.setBattery(this.robotState.batteryPercent);
    }
    if (this.robotState.networkType) {
      this.navBar?.setNetworkType(this.robotState.networkType);
    }

    // Fetch initial states
    this.dataHandler?.publishRequest(RTC_TOPIC.VUI, 1004);
    this.dataHandler?.publishRequest(RTC_TOPIC.VUI, 1006);
    this.dataHandler?.publishRequest(RTC_TOPIC.OBSTACLES_AVOID, 1002);
  }

  private showStatusScreen(): void {
    this.currentScreen = 'status';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';

    this.statusPage = new StatusPage(this.root, this.robotState, () => this.goToHub());
  }

  private showServicesScreen(): void {
    this.currentScreen = 'services';
    this.root.innerHTML = '';
    this.root.className = 'app-root services-screen';

    this.servicesPage = new ServicesPage(
      this.root,
      () => this.goToHub(),
      (name, enable) => this.toggleService(name, enable),
    );

    // Show cached service data if we have any
    if (this.serviceEntries.length > 0) {
      this.servicesPage.update(this.serviceEntries);
    }

    // Request a service list report (API 1002: SetReportFreq)
    this.requestServiceReport();
  }

  private showMappingScreen(): void {
    this.currentScreen = 'mapping';
    this.root.innerHTML = '';
    this.root.className = 'app-root mapping-screen';

    this.mappingPage = new MappingPage(
      this.root,
      () => this.goToHub(),
      (topic, data) => this.dataHandler?.publish(topic, data),
      (topic) => this.dataHandler?.subscribe(topic),
      (topic) => this.dataHandler?.unsubscribe(topic),
      (path, cb) => this.dataHandler?.requestFile(path, cb),
    );
  }

  private goToHub(): void {
    // Clean up control UI resources without disconnecting
    this.stopJoystickLoop();
    this.stopBgNoise();
    this.pipCamera?.destroy();
    this.pipCamera = null;
    this.navBar = null;
    this.actionBar = null;
    this.settingBar = null;
    this.scene3d?.destroy();
    this.scene3d = null;
    this.statusPage = null;
    this.servicesPage = null;
    this.mappingPage?.destroy();
    this.mappingPage = null;
    this.viewMode = 'three';
    this.showHubScreen();
  }

  private async init3DScene(): Promise<void> {
    try {
      const { Scene3D: S3D } = await import('./scene/scene');
      const canvas = document.createElement('canvas');
      canvas.id = 'three-canvas';
      this.root.insertBefore(canvas, this.controlUi);
      this.scene3d = new S3D(canvas);
    } catch (err) {
      console.warn('[go2:ui] WebGL not available:', err);
      this.root.classList.add('no-webgl');
    }
  }

  // ── View Toggle: 'three' (3D full, camera PIP) or 'video' (camera full) ──

  private viewMode: 'three' | 'video' = 'three';
  private videoBg: HTMLVideoElement | null = null;
  private noiseBgCanvas: HTMLCanvasElement | null = null;
  private noiseBgAnimId = 0;

  private toggleViewMode(): void {
    this.setViewMode(this.viewMode === 'three' ? 'video' : 'three');
  }

  private setViewMode(mode: 'three' | 'video'): void {
    this.viewMode = mode;
    const threeCanvas = document.getElementById('three-canvas') as HTMLCanvasElement | null;
    if (!threeCanvas) return;

    if (!this.videoBg) {
      this.videoBg = document.createElement('video');
      this.videoBg.id = 'video-bg';
      this.videoBg.className = 'video-bg-fullscreen';
      this.videoBg.autoplay = true;
      this.videoBg.playsInline = true;
      this.videoBg.muted = true;
      this.root.insertBefore(this.videoBg, this.controlUi);
    }

    if (!this.noiseBgCanvas) {
      this.noiseBgCanvas = document.createElement('canvas');
      this.noiseBgCanvas.id = 'noise-bg';
      this.noiseBgCanvas.className = 'noise-bg-fullscreen';
      this.root.insertBefore(this.noiseBgCanvas, this.controlUi);
    }

    threeCanvas.style.display = 'none';
    this.videoBg.style.display = 'none';
    this.noiseBgCanvas.style.display = 'none';
    this.stopBgNoise();

    if (mode === 'three') {
      // Main: 3D voxel map, PIP: camera feed
      threeCanvas.style.display = 'block';
      this.videoBg.srcObject = null;
      this.pipCamera?.showCamera();
    } else {
      // Main: camera feed, PIP: 3D voxel map mirrored
      if (this.videoStream) {
        this.videoBg.srcObject = this.videoStream;
        this.videoBg.style.display = 'block';
      } else {
        this.noiseBgCanvas.style.display = 'block';
        this.startBgNoise();
      }
      this.pipCamera?.showVoxel(threeCanvas);
    }
  }

  private startBgNoise(): void {
    if (this.noiseBgAnimId || !this.noiseBgCanvas) return;
    const canvas = this.noiseBgCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = 320;
    canvas.height = 240;
    const draw = () => {
      const imageData = ctx.createImageData(canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      this.noiseBgAnimId = requestAnimationFrame(draw);
    };
    this.noiseBgAnimId = requestAnimationFrame(draw);
  }

  private stopBgNoise(): void {
    if (this.noiseBgAnimId) {
      cancelAnimationFrame(this.noiseBgAnimId);
      this.noiseBgAnimId = 0;
    }
  }

  // ── Joystick Publishing Loop ──

  private startJoystickLoop(): void {
    this.joystickTimer = setInterval(() => {
      const { lx, ly, rx, ry } = this.joystickState;
      if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0) {
        this.dataHandler?.publish(RTC_TOPIC.WIRELESS_CONTROLLER, { lx, ly, rx, ry });
      }
    }, 50);
  }

  private stopJoystickLoop(): void {
    if (this.joystickTimer) {
      clearInterval(this.joystickTimer);
      this.joystickTimer = null;
    }
  }

  // ── Video & Topic Subscriptions ──

  private enableVideoAndSubscribe(): void {
    if (!this.dataHandler) return;

    this.dataHandler.publishTyped('', {
      req_type: 'disable_traffic_saving',
      instruction: 'on',
    }, DATA_CHANNEL_TYPE.RTC_INNER_REQ);

    this.dataHandler.publishTyped('', 'on', DATA_CHANNEL_TYPE.VID);

    // Subscribe to data topics (matching APK's WebRTC bridge subscriptions)
    this.dataHandler.subscribe(RTC_TOPIC.LOW_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.LF_SPORT_MOD_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.ROBOT_ODOM);
    this.dataHandler.subscribe(RTC_TOPIC.LIDAR_ARRAY);
    this.dataHandler.subscribe(RTC_TOPIC.LIDAR_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.MULTIPLE_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.SELFTEST);
    this.dataHandler.subscribe(RTC_TOPIC.SERVICE_STATE);

    // Enable LiDAR (send 5 times for reliability, like APK)
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        this.dataHandler?.publish(RTC_TOPIC.LIDAR_SWITCH, 'ON');
      }, i * 100);
    }

    this.dataHandler.onTopicData = (msg) => this.handleTopicMessage(msg);
    this.pollNetworkType();

    // APK init requests: firmware version, motion mode, gas sensor
    this.dataHandler.publishRequest(RTC_TOPIC.BASHRUNNER, 1001,
      JSON.stringify({ script: 'get_whole_packet_version.sh' }));
    this.dataHandler.publishRequest(RTC_TOPIC.MOTION_SWITCHER, 1001);
    this.dataHandler.publishRequest(RTC_TOPIC.GAS_SENSOR, 1002);
  }

  private pollNetworkType(): void {
    if (!this.dataHandler) return;
    const uuid = (Date.now() % 2 ** 31 + Math.floor(Math.random() * 1000)).toString();
    this.dataHandler.publishTyped('', {
      req_type: 'public_network_status',
      uuid,
    }, DATA_CHANNEL_TYPE.RTC_INNER_REQ);
  }

  private topicLogCount = 0;

  private handleTopicMessage(msg: DataChannelMessage): void {
    // Log first few messages per topic to help debug data flow
    if (this.topicLogCount < 20) {
      console.log('[go2:ui] Topic msg:', msg.type, msg.topic);
      this.topicLogCount++;
    }

    if (msg.type === DATA_CHANNEL_TYPE.RTC_INNER_REQ) {
      const info = msg.info as { status?: string } | undefined;
      if (info?.status) this.handleNetworkStatus(info.status);
      return;
    }

    if (msg.type === DATA_CHANNEL_TYPE.RESPONSE) {
      if (msg.topic === 'rt/api/vui/response') { this.handleVuiResponse(msg.data); return; }
      if (msg.topic === 'rt/api/obstacles_avoid/response') { this.handleObstacleResponse(msg.data); return; }
      if (msg.topic === 'rt/api/bashrunner/response') { this.handleBashrunnerResponse(msg.data); return; }
      if (msg.topic === 'rt/api/motion_switcher/response') { this.handleMotionSwitcherResponse(msg.data); return; }
      if (msg.topic === 'rt/api/robot_state/response') { this.handleRobotStateResponse(msg.data); return; }
    }

    if (!msg.topic || !msg.data) return;

    switch (msg.topic) {
      case RTC_TOPIC.LOW_STATE:
        this.handleLowState(msg.data);
        break;
      case RTC_TOPIC.ROBOT_ODOM:
        this.handleRobotOdom(msg.data);
        break;
      case RTC_TOPIC.LF_SPORT_MOD_STATE:
        this.handleSportModeState(msg.data);
        break;
      case RTC_TOPIC.LIDAR_ARRAY:
        this.handleLidarData(msg.data);
        break;
      case RTC_TOPIC.MULTIPLE_STATE:
        this.handleMultipleState(msg.data);
        break;
      case RTC_TOPIC.LIDAR_STATE:
        this.handleLidarState(msg.data);
        break;
      case RTC_TOPIC.SELFTEST:
        this.handleSelfTest(msg.data);
        break;
      case RTC_TOPIC.SERVICE_STATE:
        this.handleServiceState(msg.data);
        break;
      case RTC_TOPIC.USLAM_SERVER_LOG:
      case RTC_TOPIC.USLAM_CLOUD_WORLD:
      case RTC_TOPIC.USLAM_ODOM:
      case RTC_TOPIC.USLAM_CLOUD_MAP:
      case RTC_TOPIC.USLAM_LOC_ODOM:
      case RTC_TOPIC.USLAM_LOC_CLOUD:
      case RTC_TOPIC.USLAM_NAV_PATH:
      case RTC_TOPIC.USLAM_GRID_MAP:
        if (this.currentScreen === 'mapping' && this.mappingPage) {
          this.mappingPage.handleTopicMessage(msg.topic!, msg.data);
        }
        break;
    }
  }

  private lowStateLogCount = 0;

  private handleLowState(data: unknown): void {
    // Log first few messages to help debug field names
    if (this.lowStateLogCount < 3) {
      console.log('[go2:ui] LOW_STATE raw keys:', Object.keys(data as object));
      console.log('[go2:ui] LOW_STATE sample:', JSON.stringify(data).slice(0, 500));
      this.lowStateLogCount++;
    }

    const d = data as {
      motor_state?: Array<{ q: number; dq: number; tau_est: number; temperature: number; lost: number }>;
      bms_state?: { soc?: number; current?: number; voltage?: number; cycle?: number; temps?: number[] };
      foot_force?: number[];
      imu_state?: { temperature?: number };
    };

    if (d.motor_state) {
      if (this.scene3d) this.scene3d.robotModel.updateMotorState(d.motor_state);
      // Only first 12 motors are real (FR/FL/RR/RL hip/thigh/calf), rest are zeros
      this.robotState.motorStates = d.motor_state.slice(0, 12).map((m) => ({
        q: m.q ?? 0, dq: m.dq ?? 0, tau: m.tau_est ?? 0, temp: m.temperature ?? 0, lost: m.lost ?? 0,
      }));
      // Update nav bar max motor temp
      const maxTemp = Math.max(...this.robotState.motorStates.map((m) => m.temp));
      this.navBar?.setMotorTemp(maxTemp);
    }

    if (d.bms_state) {
      if (d.bms_state.soc !== undefined) {
        this.robotState.batteryPercent = d.bms_state.soc;
        this.navBar?.setBattery(d.bms_state.soc);
      }
      if (d.bms_state.current !== undefined) this.robotState.batteryCurrent = d.bms_state.current;
      if (d.bms_state.voltage !== undefined) this.robotState.batteryVoltage = d.bms_state.voltage;
      if (d.bms_state.cycle !== undefined) this.robotState.batteryCycles = d.bms_state.cycle;
      if (d.bms_state.temps?.[0] !== undefined) this.robotState.batteryTemp = d.bms_state.temps[0];
    }

    if (d.foot_force) this.robotState.footForce = d.foot_force;
    if (d.imu_state?.temperature !== undefined) this.robotState.imuTemp = d.imu_state.temperature;

    // Update status page if visible
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleRobotOdom(data: unknown): void {
    if (!this.scene3d) return;
    const d = data as { pose?: { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } } } };
    const pose = d.pose?.pose;
    if (pose?.position && pose?.orientation) {
      this.scene3d.robotModel.updateOdom(pose.position, pose.orientation);
    }
  }

  private handleSportModeState(data: unknown): void {
    const d = data as {
      position?: number[];
      velocity?: number[];
      imu_state?: { quaternion?: number[] };
      mode?: number;
      gait_type?: number;
    };

    if (d.position) this.robotState.position = d.position;
    if (d.velocity) this.robotState.velocity = d.velocity;
    if (d.mode !== undefined) this.robotState.mode = d.mode;
    if (d.gait_type !== undefined) this.robotState.gaitType = d.gait_type;

    if (this.scene3d && d.position && d.imu_state?.quaternion) {
      const [px, py, pz] = d.position;
      const [qw, qx, qy, qz] = d.imu_state.quaternion;
      this.scene3d.robotModel.updateOdom(
        { x: px, y: py, z: pz },
        { x: qx, y: qy, z: qz, w: qw },
      );
    }

    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleLidarData(data: unknown): void {
    if (!this.scene3d) return;
    this.scene3d.voxelMap.processCompressed(data);
  }

  private handleVuiResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const apiId = d.header?.identity?.api_id;
    const code = d.header?.status?.code;
    if (code !== 0 || typeof d.data !== 'string') return;
    try {
      const parsed = JSON.parse(d.data) as { volume?: number; brightness?: number };
      if (apiId === 1004 && parsed.volume !== undefined) {
        this.settingBar?.setVolume(parsed.volume);
      } else if (apiId === 1006 && parsed.brightness !== undefined) {
        this.settingBar?.setBrightness(parsed.brightness);
      }
    } catch { /* malformed */ }
  }

  private handleObstacleResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    if (d.header?.identity?.api_id === 1002 && d.header?.status?.code === 0 && typeof d.data === 'string') {
      try {
        const parsed = JSON.parse(d.data) as { enable?: boolean };
        if (parsed.enable !== undefined) {
          this.settingBar?.setRadar(parsed.enable);
        }
      } catch { /* malformed */ }
    }
  }

  private handleNetworkStatus(status: string): void {
    let type: string;
    if (status === 'NetworkStatus.ON_4G_CONNECTED') {
      type = '4G';
    } else if (status === 'NetworkStatus.ON_WIFI_CONNECTED') {
      // Use actual connection mode — WiFi could be STA-L or STA-T
      type = this.connectionConfig?.mode || 'STA-L';
    } else if (status === 'Undefined' || status === 'NetworkStatus.DISCONNECTED') {
      setTimeout(() => this.pollNetworkType(), 500);
      return;
    } else {
      type = status;
    }
    this.robotState.networkType = type;
    this.navBar?.setNetworkType(type);
  }

  private handleMultipleState(_data: unknown): void {
    // Reserved
  }

  private handleLidarState(data: unknown): void {
    // rt/utlidar/lidar_state provides lidar health/status info
    const d = data as Record<string, unknown>;
    this.robotState.lidarState = JSON.stringify(d);
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleSelfTest(data: unknown): void {
    const d = data as Record<string, unknown>;
    const result = JSON.stringify(d);
    if (!this.robotState.selfTestResults.includes(result)) {
      this.robotState.selfTestResults.push(result);
    }
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  private handleBashrunnerResponse(data: unknown): void {
    console.log('[go2:ui] Bashrunner raw response:', JSON.stringify(data));
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    console.log('[go2:ui] Bashrunner status code:', d.header?.status?.code, 'api_id:', d.header?.identity?.api_id, 'data type:', typeof d.data, 'data:', d.data);
    if (d.header?.status?.code === 0 && typeof d.data === 'string') {
      try {
        const parsed = JSON.parse(d.data) as { result?: string; info?: string; type?: string };
        console.log('[go2:ui] Bashrunner parsed data:', parsed);
        if (parsed.info) {
          this.robotState.firmwareVersion = parsed.info;
          console.log('[go2:ui] Firmware version set to:', parsed.info);
        } else if (parsed.result) {
          this.robotState.firmwareVersion = parsed.result;
          console.log('[go2:ui] Firmware version set to:', parsed.result);
        } else {
          this.robotState.firmwareVersion = d.data;
          console.log('[go2:ui] Firmware version (raw data):', d.data);
        }
      } catch {
        // data might be the raw string
        this.robotState.firmwareVersion = d.data;
        console.log('[go2:ui] Firmware version (parse failed, raw):', d.data);
      }
      if (this.currentScreen === 'status' && this.statusPage) {
        this.statusPage.update(this.robotState);
      }
    } else {
      console.warn('[go2:ui] Bashrunner response not code 0 or data not string. code:', d.header?.status?.code, 'data:', d.data);
    }
  }

  private handleMotionSwitcherResponse(data: unknown): void {
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    if (d.header?.status?.code === 0 && typeof d.data === 'string') {
      try {
        const parsed = JSON.parse(d.data) as { name?: string; mode?: string };
        this.robotState.motionMode = parsed.name || parsed.mode || d.data;
      } catch {
        this.robotState.motionMode = d.data;
      }
      if (this.currentScreen === 'status' && this.statusPage) {
        this.statusPage.update(this.robotState);
      }
    }
  }

  private handleRobotStateResponse(data: unknown): void {
    console.log('[go2:ui] Robot state response:', JSON.stringify(data));
    const d = data as {
      header?: { identity?: { api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const apiId = d.header?.identity?.api_id;
    const code = d.header?.status?.code;

    // ServiceSwitch response (1001)
    if (apiId === 1001) {
      if (code !== 0) {
        console.warn('[go2:ui] ServiceSwitch error code:', code);
      }
      if (typeof d.data === 'string') {
        try {
          const parsed = JSON.parse(d.data) as { status?: number };
          if (parsed.status === 5) {
            // Protected service error (5202)
            console.warn('[go2:ui] Service is protected');
          }
        } catch { /* ignore */ }
      }
      // Re-request service list after toggle
      this.requestServiceReport();
    }
  }

  private handleServiceState(data: unknown): void {
    // rt/servicestate may arrive as a JSON string (double-encoded) or parsed array
    let entries: Array<{ name: string; status: number; protect: number | boolean; version?: string }>;
    if (typeof data === 'string') {
      try {
        entries = JSON.parse(data);
      } catch {
        console.warn('[go2:ui] Failed to parse service state string');
        return;
      }
    } else if (Array.isArray(data)) {
      entries = data;
    } else {
      return;
    }

    this.serviceEntries = entries.map((e) => ({
      name: e.name,
      status: e.status,
      protect: !!e.protect,  // convert 0/1 to boolean
      version: e.version || '',
    }));

    if (this.currentScreen === 'services' && this.servicesPage) {
      this.servicesPage.update(this.serviceEntries);
    }
  }

  private requestServiceReport(): void {
    // API 1002: SetReportFreq — tells robot to publish service list to rt/servicestate
    // Duration 60s, auto-repeat before expiry
    this.dataHandler?.publishRequest(
      RTC_TOPIC.ROBOT_STATE,
      1002,
      JSON.stringify({ interval: 2, duration: 60 }),
    );

    // Clear any existing timer and set up auto-repeat before the 60s expires
    if (this.serviceReportTimer) clearInterval(this.serviceReportTimer);
    this.serviceReportTimer = setInterval(() => {
      if (this.currentScreen === 'services' && this.dataHandler) {
        this.dataHandler.publishRequest(
          RTC_TOPIC.ROBOT_STATE,
          1002,
          JSON.stringify({ interval: 2, duration: 60 }),
        );
      } else {
        // Stop repeating if we left the services screen
        if (this.serviceReportTimer) {
          clearInterval(this.serviceReportTimer);
          this.serviceReportTimer = null;
        }
      }
    }, 50_000); // Re-request at 50s (before 60s expiry)
  }

  private toggleService(name: string, enable: boolean): void {
    console.log('[go2:ui] Toggle service:', name, 'enable:', enable);
    // API 1001: ServiceSwitch
    this.dataHandler?.publishRequest(
      RTC_TOPIC.ROBOT_STATE,
      1001,
      JSON.stringify({ name, switch: enable ? 1 : 0 }),
    );
  }

  // ── Connection ──

  private async connect(config: ConnectionConfig): Promise<void> {
    if (this.webrtc) {
      this.disconnect();
      return;
    }

    this.connectionConfig = config;
    this.connectionPanel?.setConnecting(true);
    this.connectionPanel?.setStatus('Connecting...', 'info');

    const callbacks: ConnectionCallbacks = {
      onStateChange: (state: ConnectionState) => this.onStateChange(state),
      onValidated: () => {
        this.connectionPanel?.setStatus('Validated!', 'success');
        setTimeout(() => {
          this.enableVideoAndSubscribe();
          this.showHubScreen();
        }, 500);
      },
      onMessage: (msg: DataChannelMessage) => {
        if (this.dataHandler) this.dataHandler.handleMessage(msg);
      },
      onVideoTrack: (stream: MediaStream) => {
        this.videoStream = stream;
        this.pipCamera?.setStream(stream);
        if (this.viewMode === 'video' && this.videoBg) {
          this.videoBg.srcObject = stream;
          this.videoBg.style.display = 'block';
          if (this.noiseBgCanvas) this.noiseBgCanvas.style.display = 'none';
          this.stopBgNoise();
        }
      },
      onAudioTrack: () => {},
    };

    const onStep = (msg: string) => this.connectionPanel?.setStatus(msg, 'info');

    try {
      if (config.mode === 'STA-T') {
        let token = config.token;
        if (!token) {
          if (!config.email || !config.password) throw new Error('Email and password required');
          onStep('Logging in...');
          token = await loginWithEmail(config.email, config.password);
          onStep('Login successful');
        }
        if (!config.serialNumber) throw new Error('Serial number required');
        this.webrtc = await connectRemote(config.serialNumber, token, callbacks, onStep);
      } else {
        if (!config.ip) throw new Error('IP address required');
        this.webrtc = await connectLocal(config.ip, config.mode, callbacks, onStep);
      }
      this.dataHandler = new DataChannelHandler(this.webrtc, callbacks);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      this.connectionPanel?.setStatus(message, 'error');
      this.connectionPanel?.setConnecting(false);
      this.webrtc?.close();
      this.webrtc = null;
    }
  }

  private onStateChange(state: ConnectionState): void {
    switch (state) {
      case 'connecting':
        this.connectionPanel?.setStatus('WebRTC connecting...', 'info');
        break;
      case 'connected':
        this.connectionPanel?.setConnected(true);
        this.connectionPanel?.setStatus('Connected, awaiting validation...', 'info');
        break;
      case 'disconnected':
        if (this.currentScreen !== 'connection') {
          // Lost connection while in hub/control/status — show message and go back
          this.disconnect();
          this.connectionPanel?.setStatus('Connection lost — robot disconnected', 'error');
        } else {
          this.disconnect();
        }
        break;
      case 'failed':
        this.disconnect();
        this.connectionPanel?.setStatus('WebRTC connection failed — check network', 'error');
        break;
    }
  }

  // ── Robot Commands ──

  private sendStop(active: boolean): void {
    if (active) {
      this.dataHandler?.publishRequest(RTC_TOPIC.SPORT_MOD, SPORT_CMD.StopMove);
      setTimeout(() => {
        this.dataHandler?.publishRequest(RTC_TOPIC.SPORT_MOD, SPORT_CMD.Damp);
      }, 300);
    }
  }

  private sendRadarToggle(enabled: boolean): void {
    this.dataHandler?.publishRequest(RTC_TOPIC.OBSTACLES_AVOID, 1001, JSON.stringify({ enable: enabled }));
  }

  private sendLidarToggle(enabled: boolean): void {
    const state = enabled ? 'ON' : 'OFF';
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.dataHandler?.publish(RTC_TOPIC.LIDAR_SWITCH, state), i * 100);
    }
    if (!enabled) this.scene3d?.voxelMap.clear();
    this.scene3d?.robotModel.setRadarSpinning(enabled);
  }

  private sendLamp(level: number): void {
    this.dataHandler?.publishRequest(RTC_TOPIC.VUI, 1005, JSON.stringify({ brightness: level }));
  }

  private sendVolume(level: number): void {
    this.dataHandler?.publishRequest(RTC_TOPIC.VUI, 1003, JSON.stringify({ volume: level }));
  }

  private disconnect(): void {
    this.stopJoystickLoop();
    this.stopBgNoise();
    this.dataHandler?.destroy();
    this.dataHandler = null;
    this.webrtc?.close();
    this.webrtc = null;
    this.videoStream = null;
    this.videoBg = null;
    this.noiseBgCanvas = null;
    this.connectionConfig = null;
    this.pipCamera?.destroy();
    this.pipCamera = null;
    this.navBar = null;
    this.actionBar = null;
    this.settingBar = null;
    this.statusPage = null;
    this.servicesPage = null;
    this.mappingPage?.destroy();
    this.mappingPage = null;
    this.serviceEntries = [];
    if (this.serviceReportTimer) {
      clearInterval(this.serviceReportTimer);
      this.serviceReportTimer = null;
    }
    this.scene3d?.destroy();
    this.scene3d = null;
    this.viewMode = 'three';
    this.showConnectionScreen();
  }
}

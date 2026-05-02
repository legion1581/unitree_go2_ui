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
import { AccountPage } from './components/account-page';
import { BtStatusIcon, type BluetoothStatus } from './components/bt-status-icon';
import { BtPage } from './components/bt-page';
import { ThemeToggle } from './components/theme-toggle';
import { AccountStatusIcon } from './components/account-status-icon';
import { btBackend } from '../api/bt-backend';
import { cloudApi } from '../api/unitree-cloud';
import { theme } from './theme';
import { connectLocal } from '../connection/local-connector';
import { promptAesKey } from './components/aes-key-prompt';
import { connectRemote, loginWithEmail } from '../connection/remote-connector';
import { DataChannelHandler } from '../protocol/data-channel';
import { RTC_TOPIC, SPORT_CMD, DATA_CHANNEL_TYPE } from '../protocol/topics';
import type { WebRTCConnection } from '../connection/webrtc';
import type { Scene3D } from './scene/scene';

type Screen = 'landing' | 'connection' | 'hub' | 'control' | 'status' | 'services' | 'mapping' | 'account' | 'bt';

export class App {
  private root: HTMLElement;
  private currentScreen: Screen = 'landing';
  // True when the user is in Account Manager via the landing screen (not via
  // the in-connection hub). Drives where the back button returns to.
  private accountFromLanding = false;

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
  private accountPage: AccountPage | null = null;
  private serviceEntries: ServiceEntry[] = [];
  private serviceReportTimer: ReturnType<typeof setInterval> | null = null;

  // Joystick state
  private joystickState = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private joystickTimer: ReturnType<typeof setInterval> | null = null;

  // Bluetooth status (persistent across screens)
  private btStatusIcon: BtStatusIcon | null = null;
  private themeToggle: ThemeToggle | null = null;
  private accountStatusIcon: AccountStatusIcon | null = null;
  private btStatus: BluetoothStatus = {
    robotConnected: false, robotAddress: '',
    remoteConnected: false, remoteName: '', remoteAddress: '',
  };

  // BT remote relay state
  private relayOn = false;
  private relayUnsub: (() => void) | null = null;
  private leftJoystickWrap: HTMLElement | null = null;
  private rightJoystickWrap: HTMLElement | null = null;
  private btPage: BtPage | null = null;
  // True when BT page is reached via the landing tile (vs the hub).
  // Drives where the back button returns to (mirrors accountFromLanding).
  private btFromLanding = false;

  // Robot state (accumulated from topic messages)
  private robotState: import('./components/status-page').RobotStatus = {
    batteryPercent: 0,
    batteryCurrent: 0,
    batteryVoltage: 0,
    batteryCycles: 0,
    batteryTemp: 0,
    motorStates: [],
    networkType: '',
    footForce: [],
    imuTemp: 0,
    mode: 0,
    gaitType: 0,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    firmwareVersion: '',
    motionMode: '',
    lidarState: '',
    selfTestResults: [],
  };

  // Debug: throttle for the bms_state dump (see handleLowState).
  private bmsLogLast = 0;
  private bmsLogged = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = '';
    root.className = 'app-root';

    // Eager theme init — applies data-theme attribute to <html> so CSS picks it up
    theme();

    // Persistent theme toggle (sun/moon) next to the BT icon
    this.themeToggle = new ThemeToggle(document.body);

    // Persistent account-status indicator — leftmost of the three icons.
    // Pure status display: hover for tooltip, no click action.
    this.accountStatusIcon = new AccountStatusIcon(document.body);

    // Persistent Bluetooth status icon (mounted on document.body so it survives
    // screen changes). Hidden on the control view where the relay icon takes over.
    this.btStatusIcon = new BtStatusIcon(document.body);
    this.btStatusIcon.onStatusChange((s) => {
      this.btStatus = s;
      // Update nav-bar BT icon (control view)
      this.updateNavBarBtIcon();
      // Update mapping page's inline BT icon if present.
      this.mappingPage?.setBtStatus(s);
      if (this.currentScreen === 'control') {
        const label = s.remoteName || s.remoteAddress;
        this.settingBar?.setRelayAvailable(s.remoteConnected, label);
        if (!s.remoteConnected && this.relayOn) this.setRelay(false);
      }
    });

    // Auto-login: if a token is in localStorage, restore it and refresh
    // proactively so the persistent account-status icon shows the right
    // state on first paint of the landing screen.
    if (cloudApi.loadSession()) {
      void cloudApi.ensureFreshToken().then(async (ok) => {
        if (ok && !cloudApi.user) {
          try { await cloudApi.getUserInfo(); } catch { /* ignore */ }
        }
      });
    }

    this.showLandingScreen();
  }

  // ── Screen Navigation ──

  private showLandingScreen(): void {
    this.currentScreen = 'landing';
    this.accountFromLanding = false;
    this.btFromLanding = false;
    this.root.innerHTML = '';
    this.root.className = 'app-root landing-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);

    const wrap = document.createElement('div');
    wrap.className = 'landing-container';

    const title = document.createElement('h2');
    title.className = 'landing-title';
    title.textContent = 'Unitree UI';
    wrap.appendChild(title);

    const tiles = document.createElement('div');
    tiles.className = 'landing-tiles';

    const connectBtn = document.createElement('button');
    connectBtn.className = 'hub-btn hub-btn-primary';
    connectBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg><span>Connect</span>`;
    connectBtn.addEventListener('click', () => this.showConnectionScreen());
    tiles.appendChild(connectBtn);

    const acctBtn = document.createElement('button');
    acctBtn.className = 'hub-btn hub-btn-secondary';
    acctBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>Account Manager</span>`;
    acctBtn.addEventListener('click', () => {
      this.accountFromLanding = true;
      this.showAccountScreen();
    });
    tiles.appendChild(acctBtn);

    const btBtn = document.createElement('button');
    btBtn.className = 'hub-btn hub-btn-secondary';
    btBtn.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5 17.5 17.5 12 23V1l5.5 5.5L6.5 17.5"/></svg><span>Bluetooth</span>`;
    btBtn.addEventListener('click', () => {
      this.btFromLanding = true;
      this.showBtScreen();
    });
    tiles.appendChild(btBtn);

    wrap.appendChild(tiles);
    this.root.appendChild(wrap);
  }

  private showConnectionScreen(): void {
    this.currentScreen = 'connection';
    this.root.innerHTML = '';
    this.applyConnectionFamilyClass();
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);

    const modal = document.createElement('div');
    modal.className = 'connection-modal';
    this.root.appendChild(modal);

    this.connectionPanel = new ConnectionPanel(
      modal,
      (config) => this.connect(config),
      () => this.showLandingScreen(),
      () => {
        this.accountFromLanding = true;
        this.showAccountScreen();
      },
      () => this.applyConnectionFamilyClass(),
    );
  }

  /** Set connection-screen background art to match the currently selected
   *  family. Called on screen entry and whenever the user toggles the
   *  Family pill on the cloud-prefs row. */
  private applyConnectionFamilyClass(): void {
    if (this.currentScreen !== 'connection') return;
    const familyMod = cloudApi.connectFamily === 'G1' ? 'connection-family-g1' : 'connection-family-go2';
    this.root.className = `app-root connection-screen ${familyMod}`;
  }


  private showHubScreen(): void {
    this.currentScreen = 'hub';
    this.root.innerHTML = '';
    this.root.className = 'app-root hub-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);

    const hub = document.createElement('div');
    hub.className = 'hub-container';

    const isConnected = !!this.webrtc;
    const isRemoteMode = this.connectionConfig?.mode === 'STA-T';

    // Title + connection info — refreshed whenever the Remote-mode picker
    // changes so the header follows the currently selected robot.
    const title = document.createElement('h2');
    title.className = 'hub-title';
    hub.appendChild(title);

    const info = document.createElement('div');
    info.className = 'hub-info';
    hub.appendChild(info);

    const renderHeader = (): void => {
      const sn = this.connectionConfig?.serialNumber || '';
      const robotName = sn ? sn : (isConnected ? 'Connected' : 'Dashboard');
      title.textContent = robotName;

      const infoItems: string[] = [];
      if (sn) infoItems.push(`SN: ${sn}`);
      if (this.connectionConfig?.ip) infoItems.push(`IP: ${this.connectionConfig.ip}`);
      infoItems.push(`Mode: ${this.connectionConfig?.mode || 'N/A'}`);
      if (isConnected) infoItems.push('WebRTC: Connected');
      else if (isRemoteMode) infoItems.push('WebRTC: Not connected');
      info.textContent = infoItems.join(' | ');
    };
    renderHeader();

    // Remote auto-connects from the Connect screen, so the hub is always
    // shown post-validation — no per-mode WebRTC button or robot picker
    // here. Feature buttons render straight away for both Local and Remote.

    // ── Feature buttons ──
    const btnRow = document.createElement('div');
    btnRow.className = 'hub-buttons';
    const needsWebRTC = false;

    // WebView
    const controlBtn = document.createElement('button');
    controlBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-primary'}`;
    controlBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg><span>WebView</span>`;
    if (!needsWebRTC) controlBtn.addEventListener('click', () => this.showControlUi());
    else controlBtn.disabled = true;
    btnRow.appendChild(controlBtn);

    // Status
    const statusBtn = document.createElement('button');
    statusBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    statusBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg><span>Status</span>`;
    if (!needsWebRTC) statusBtn.addEventListener('click', () => this.showStatusScreen());
    else statusBtn.disabled = true;
    btnRow.appendChild(statusBtn);

    // Services
    const svcBtn = document.createElement('button');
    svcBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
    svcBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg><span>Services</span>`;
    if (!needsWebRTC) svcBtn.addEventListener('click', () => this.showServicesScreen());
    else svcBtn.disabled = true;
    btnRow.appendChild(svcBtn);

    // 3D LiDAR Mapping button — Go2 only. The G1 Explorer webview doesn't
    // expose any mapping UI even though the URDF includes a mid360 LiDAR
    // (verified against the decompiled APK 1.9.3 — pages/ has no mapping
    // chunk and the G1 series subscription path skips rt/utlidar/*).
    if (cloudApi.connectFamily !== 'G1') {
      const mapBtn = document.createElement('button');
      mapBtn.className = `hub-btn ${needsWebRTC ? 'hub-btn-disabled' : 'hub-btn-secondary'}`;
      mapBtn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg><span>Mapping</span>`;
      if (!needsWebRTC) mapBtn.addEventListener('click', () => this.showMappingScreen());
      else mapBtn.disabled = true;
      btnRow.appendChild(mapBtn);
    }

    // Account Manager lives on the landing page now — no need to surface it
    // again on the hub. Going back to landing (via Disconnect) and clicking
    // Account Manager covers the same flow.

    hub.appendChild(btnRow);

    // Disconnect button — same for Local and Remote (auto-connect means
    // we're always connected here).
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
    this.btStatusIcon?.setVisible(false); this.themeToggle?.setVisible(false);
    this.accountStatusIcon?.setVisible(false);

    // Overlay container
    this.controlUi = document.createElement('div');
    this.controlUi.className = 'control-overlay';
    this.root.appendChild(this.controlUi);

    this.init3DScene();

    // Nav bar (top) — back goes to hub, not disconnect.
    // BT icon is a passive status indicator (matches the floating one);
    // the actual BT controls live on the landing-page Bluetooth tile.
    this.navBar = new NavBar(this.controlUi, () => this.goToHub());
    this.updateNavBarBtIcon();

    // PIP camera. The PIP bubble swaps the 3D scene and the camera between
    // main-view and pip on tap. G1 has no 3D scene (camera is the only
    // view), so the PIP would be empty in one mode and redundant in the
    // other — skip it on humanoid families.
    if (cloudApi.connectFamily !== 'G1') {
      this.pipCamera = new PipCamera(this.controlUi);
      if (this.videoStream) {
        this.pipCamera.setStream(this.videoStream);
      }
      this.pipCamera.setOnTap(() => this.toggleViewMode());
    }

    // Setting bar
    this.settingBar = new SettingBar(this.controlUi, {
      family: cloudApi.connectFamily,
      onRadarToggle: (enabled) => this.sendRadarToggle(enabled),
      onLidarToggle: (enabled) => this.sendLidarToggle(enabled),
      onLampSet: (level) => this.sendLamp(level),
      onVolumeSet: (level) => this.sendVolume(level),
      onRelayToggle: (enabled) => this.setRelay(enabled),
      onWaistLockToggle: (lock) => this.sendWaistLock(lock),
    });
    this.settingBar.setRelayAvailable(this.btStatus.remoteConnected, this.btStatus.remoteName || this.btStatus.remoteAddress);

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
    this.leftJoystickWrap = w1;

    const w2 = document.createElement('div');
    w2.className = 'wrapper-2';
    this.actionBar = new ActionBar(w2, (action) => {
      // G1 modes + arm gestures all route through G1_ARM_REQUEST (the
      // humanoid uses 'rt/api/arm/request' instead of 'rt/api/sport/request').
      // Go2 keeps SPORT_MOD as before. Verified against Explorer 1.9.3.
      const topic = cloudApi.connectFamily === 'G1' ? RTC_TOPIC.G1_ARM_REQUEST : RTC_TOPIC.SPORT_MOD;
      console.log(`[action] REQ → ${action.name} (topic=${topic} api_id=${action.apiId}, param=${action.param ?? '{}'})`);
      this.dataHandler?.publishRequest(topic, action.apiId, action.param);
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
    this.rightJoystickWrap = w3;

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
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);

    this.statusPage = new StatusPage(this.root, this.robotState, () => this.goToHub(), {
      mode: this.connectionConfig?.mode,
      ip: this.connectionConfig?.ip,
      serialNumber: this.connectionConfig?.serialNumber,
    });
  }

  private showServicesScreen(): void {
    this.currentScreen = 'services';
    this.root.innerHTML = '';
    this.root.className = 'app-root services-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);

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
    // The mapping page-header has its own inline BT + theme + battery cluster
    // (same shape as NavBar) — hide the body-mounted persistent icons so they
    // don't overlap.
    this.btStatusIcon?.setVisible(false); this.themeToggle?.setVisible(false);
    this.accountStatusIcon?.setVisible(false);

    this.mappingPage = new MappingPage(
      this.root,
      () => this.goToHub(),
      (topic, data) => this.dataHandler?.publish(topic, data),
      (topic) => this.dataHandler?.subscribe(topic),
      (topic) => this.dataHandler?.unsubscribe(topic),
      (path, cb) => this.dataHandler?.requestFile(path, cb),
      (path, b64, onProgress) =>
        this.dataHandler
          ? this.dataHandler.pushFile(path, b64, 'uslam_final_pcd', 30 * 1024, onProgress)
          : Promise.reject(new Error('Data channel not ready')),
    );
    // Seed the battery widget with the last-known value so it's not blank
    // until the next LOW_STATE message arrives.
    if (this.robotState.batteryPercent > 0) {
      this.mappingPage.setBattery(this.robotState.batteryPercent);
    }
    // Seed network type so the header shows it on entry.
    if (this.connectionConfig?.mode) {
      this.mappingPage.setNetworkType(this.connectionConfig.mode);
    }
    // Seed motor temp from cached state.
    if (this.robotState.motorStates.length > 0) {
      const temps = this.robotState.motorStates.map((m) => m.temp).filter((t): t is number => Number.isFinite(t));
      if (temps.length > 0) this.mappingPage.setMotorTemp(Math.max(...temps));
    }
    // Forward BT status changes so the inline BT icon stays in sync.
    this.mappingPage.setBtStatus(this.btStatus);

    // Re-send VID enable on the data channel so the video track stays alive
    // when entering the mapping page (it's already on after connection
    // validation, but a duplicate is harmless and keeps the contract obvious).
    this.dataHandler?.publishTyped('', 'on', DATA_CHANNEL_TYPE.VID);

    // Attach the existing video stream to the page's PiP overlay.
    if (this.videoStream) {
      this.mappingPage.setStream(this.videoStream);
    }
  }

  private showAccountScreen(): void {
    this.currentScreen = 'account';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    const back = this.accountFromLanding ? () => this.showLandingScreen() : () => this.goToHub();
    this.accountPage = new AccountPage(this.root, back);
  }

  private showBtScreen(): void {
    this.currentScreen = 'bt';
    this.root.innerHTML = '';
    this.root.className = 'app-root status-screen';
    this.btStatusIcon?.setVisible(true); this.themeToggle?.setVisible(true);
    this.accountStatusIcon?.setVisible(true);
    this.btPage?.destroy();
    const back = this.btFromLanding ? () => this.showLandingScreen() : () => this.goToHub();
    this.btPage = new BtPage(this.root, back);
  }

  private goToHub(): void {
    // Clean up control UI resources without disconnecting
    this.stopJoystickLoop();
    this.setRelay(false);
    this.btPage?.destroy();
    this.btPage = null;
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
    this.accountPage?.destroy();
    this.accountPage = null;
    this.viewMode = 'three';
    this.showHubScreen();
  }

  private async init3DScene(): Promise<void> {
    // G1's Explorer webview ships no 3D model — the camera stream IS the
    // view. Skip Scene3D / Go2.glb load; mount the fullscreen video bg
    // immediately and lock viewMode to 'video' so the rest of the UI
    // (toggle, PIP) doesn't try to swap with a non-existent canvas.
    if (cloudApi.connectFamily === 'G1') {
      this.viewMode = 'video';
      this.videoBg = document.createElement('video');
      this.videoBg.id = 'video-bg';
      this.videoBg.className = 'video-bg-fullscreen';
      this.videoBg.autoplay = true;
      this.videoBg.playsInline = true;
      this.videoBg.muted = true;
      // Override the .video-bg-fullscreen CSS default of display:none —
      // Go2's setViewMode() does this in the swap path; for G1 we mount
      // the video element straight to visible.
      this.videoBg.style.display = 'block';
      this.root.insertBefore(this.videoBg, this.controlUi);
      this.noiseBgCanvas = document.createElement('canvas');
      this.noiseBgCanvas.id = 'noise-bg';
      this.noiseBgCanvas.className = 'noise-bg-fullscreen';
      this.root.insertBefore(this.noiseBgCanvas, this.controlUi);
      if (this.videoStream) {
        this.videoBg.srcObject = this.videoStream;
      } else {
        // Static-noise placeholder until the WebRTC video track lands.
        // The handler in onVideoTrack swaps the noise canvas off and the
        // video element on (it's already display:block) when stream arrives.
        this.noiseBgCanvas.style.display = 'block';
        this.startBgNoise();
      }
      return;
    }
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

  // ── Nav-bar BT icon ──

  private updateNavBarBtIcon(): void {
    if (!this.navBar) return;
    const s = this.btStatus;
    const connected = s.robotConnected || s.remoteConnected;
    const parts: string[] = [];
    if (s.robotConnected) parts.push(`Robot: ${s.robotAddress}`);
    if (s.remoteConnected) parts.push(`Remote: ${s.remoteName || s.remoteAddress}`);
    const tooltip = connected ? parts.join(' · ') : 'Bluetooth: not connected';
    this.navBar.setBluetoothStatus(connected, tooltip);
  }

  // ── BT Remote Relay Loop ──

  private setRelay(enabled: boolean): void {
    if (enabled) {
      if (this.relayUnsub) return;
      this.relayOn = true;
      // Zero virtual joystick state and hide them — BT remote is in charge
      this.joystickState = { lx: 0, ly: 0, rx: 0, ry: 0 };
      if (this.leftJoystickWrap) this.leftJoystickWrap.style.visibility = 'hidden';
      if (this.rightJoystickWrap) this.rightJoystickWrap.style.visibility = 'hidden';

      // Subscribe to BT backend remote_state → publish to robot on every packet (~20 Hz)
      const order = ['R1','L1','Start','Select','R2','L2','F1','F2','A','B','X','Y','Up','Right','Down','Left'];
      this.relayUnsub = btBackend().subscribe('remote_state', (s: { lx: number; ly: number; rx: number; ry: number; buttons: Record<string, boolean> }) => {
        if (!this.dataHandler) return;
        let keys = 0;
        for (let i = 0; i < order.length; i++) {
          if (s.buttons[order[i]]) keys |= (1 << i);
        }
        this.dataHandler.publish(RTC_TOPIC.WIRELESS_CONTROLLER, {
          lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry, keys,
        });
      });
    } else {
      this.relayOn = false;
      this.relayUnsub?.();
      this.relayUnsub = null;
      if (this.leftJoystickWrap) this.leftJoystickWrap.style.visibility = '';
      if (this.rightJoystickWrap) this.rightJoystickWrap.style.visibility = '';
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

    // Subscribe to data topics (matching APK's WebRTC bridge subscriptions).
    // Family-specific paths:
    //   * Go2: bms_state lives inside lowstate; single IMU on imu_state.
    //   * G1:  bms_state arrives on its own topic (rt/lf/bmsstate);
    //          dual IMU on rt/lf/lowstate_doubleimu (Body + Crotch);
    //          no LiDAR / SLAM topics — Explorer doesn't expose them.
    this.dataHandler.subscribe(RTC_TOPIC.LOW_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.LF_SPORT_MOD_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.MULTIPLE_STATE);
    this.dataHandler.subscribe(RTC_TOPIC.SELFTEST);
    this.dataHandler.subscribe(RTC_TOPIC.SERVICE_STATE);
    if (cloudApi.connectFamily === 'G1') {
      this.dataHandler.subscribe(RTC_TOPIC.BMS_STATE);
      this.dataHandler.subscribe(RTC_TOPIC.SECONDARY_IMU);
      this.dataHandler.subscribe(RTC_TOPIC.G1_ARM_ACTION_STATE);
    } else {
      this.dataHandler.subscribe(RTC_TOPIC.ROBOT_ODOM);
      this.dataHandler.subscribe(RTC_TOPIC.LIDAR_ARRAY);
      this.dataHandler.subscribe(RTC_TOPIC.LIDAR_STATE);
      // Enable LiDAR (send 5 times for reliability, like APK).
      // G1 has a mid360 in the URDF but the Explorer webview never
      // toggles it on, so we skip the switch on humanoid families.
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          this.dataHandler?.publish(RTC_TOPIC.LIDAR_SWITCH, 'ON');
        }, i * 100);
      }
    }

    this.dataHandler.onTopicData = (msg) => this.handleTopicMessage(msg);
    this.pollNetworkType();

    // APK init requests: firmware version, motion mode, gas sensor
    this.runBashScript('get_whole_packet_version.sh');
    this.dataHandler.publishRequest(RTC_TOPIC.MOTION_SWITCHER, 1001);
    this.dataHandler.publishRequest(RTC_TOPIC.GAS_SENSOR, 1002);

    // G1 has dedicated hardware + software version scripts
    // (BaseRunner.GET_HARDWARE_VERSION, GET_SOFTWARE_VERSION) per
    // com/unitree/webrtc/data/BaseRunner.java in the decompiled apk.
    if (cloudApi.connectFamily === 'G1') {
      this.runBashScript('get_hardware_version.sh');
      this.runBashScript('get_software_version.sh');
      this.runBashScript('get_ip_address.sh');
    }
  }

  /** id → script line, used to correlate bashrunner responses to the
   *  request that triggered them (multiple scripts share api_id 1001). */
  private bashrunnerPending: Map<number, string> = new Map();

  /** Submit a bashrunner script line. The wire body matches what the
   * Explorer apk emits at WebEventServiceImpl.java:128 — a single 'script'
   * field whose value is "<script.sh> <space-separated args>". Logs the
   * request and tracks the request id so the response handler can route
   * to the right RobotStatus field. */
  private runBashScript(scriptLine: string): number | undefined {
    if (!this.dataHandler) return;
    const id = this.dataHandler.publishRequest(RTC_TOPIC.BASHRUNNER, 1001,
      JSON.stringify({ script: scriptLine }));
    this.bashrunnerPending.set(id, scriptLine);
    return id;
  }

  /** Lock (true) or unlock (false) the G1 waist motor. Fires
   *  BaseRunner.G1_SETUP_MACHINE_TYPE with arg "6"=lock / "5"=unlock,
   *  per BaseInfoViewModel.kt:570. */
  private sendWaistLock(lock: boolean): void {
    this.runBashScript(`demarcate_setup_machine_type.sh ${lock ? 6 : 5}`);
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
      if (msg.topic === 'rt/api/sport/response') {
        const d = msg.data as { header?: { identity?: { api_id?: number }; status?: { code?: number } }; data?: unknown };
        const apiId = d?.header?.identity?.api_id;
        const code = d?.header?.status?.code;
        const ok = code === 0;
        console.log(`[go2:action] ${ok ? 'RES ←' : 'ERR ←'} api_id=${apiId} code=${code}${d?.data !== undefined ? ' data=' + JSON.stringify(d.data) : ''}`);
        return;
      }
    }

    if (!msg.topic || !msg.data) return;

    switch (msg.topic) {
      case RTC_TOPIC.LOW_STATE:
        this.handleLowState(msg.data);
        break;
      case RTC_TOPIC.BMS_STATE:
        // G1 publishes battery on its own topic; payload is the bms_state
        // struct directly (not wrapped under d.bms_state like in lowstate).
        this.handleLowState({ bms_state: msg.data });
        break;
      case RTC_TOPIC.SECONDARY_IMU:
        this.handleSecondaryImu(msg.data);
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

  private handleLowState(data: unknown): void {
    const d = data as {
      motor_state?: Array<{
        q: number; dq: number; tau_est: number;
        // Go2 ships temperature as a scalar, G1 as [casing, winding].
        temperature: number | number[];
        lost: number;
        reserve?: number[];
        motorstate?: number;
      }>;
      bms_state?: { soc?: number; current?: number; voltage?: number; cycle?: number; temps?: number[] };
      foot_force?: number[];
      imu_state?: { temperature?: number; rpy?: number[] };
      // Go2 lowstate root carries the pack voltage (V) and a body NTC (°C);
      // G1 doesn't ship these — they're read defensively below.
      power_v?: number;
      temperature_ntc1?: number;
    };


    if (d.motor_state) {
      if (this.scene3d) this.scene3d.robotModel.updateMotorState(d.motor_state);
      if (this.mappingPage) this.mappingPage.updateMotorState(d.motor_state);
      // Go2 lowstate carries 12 real motors followed by zeros; G1 has up to
      // 29 (12 legs + 3 waist + 14 arms). Slice family-aware so the status
      // page sees the full motor set on G1 but stays trim on Go2.
      const motorLimit = cloudApi.connectFamily === 'G1' ? 29 : 12;
      this.robotState.motorStates = d.motor_state.slice(0, motorLimit).map((m) => {
        // G1's per-motor temperature is an array [casing, winding]; Go2's is
        // a scalar. The summary bar only ever needs one number — pick the
        // hotter of the two on G1 so 'Max Motor Temp' stays meaningful.
        // Filter to finite numbers before Math.max — a dropped frame can
        // surface as NaN/undefined and pollute the navbar.
        const tempArr = Array.isArray(m.temperature) ? m.temperature : undefined;
        const finiteArr = tempArr ? tempArr.filter((t): t is number => Number.isFinite(t)) : undefined;
        const tempScalar = finiteArr && finiteArr.length > 0
          ? Math.max(...finiteArr)
          : (Number.isFinite(m.temperature as number) ? (m.temperature as number) : 0);
        return {
          q: m.q ?? 0,
          dq: m.dq ?? 0,
          tau: m.tau_est ?? 0,
          temp: tempScalar,
          lost: m.lost ?? 0,
          temperature: tempArr,
          reserve: Array.isArray(m.reserve) ? m.reserve : undefined,
          motorstate: typeof m.motorstate === 'number' ? m.motorstate : undefined,
        };
      });
      // Update nav bar max motor temp. Math.max(...[]) is -Infinity and
      // Math.max(...[NaN, ...]) is NaN, so filter to finite numbers and
      // fall back to 0 if nothing remains. Without this the navbar
      // chip can read 'NaN°C' on a fresh G1 connection where motor
      // temperatures arrive on the next frame after the array shape
      // is already established.
      const temps = this.robotState.motorStates.map((m) => m.temp).filter((t): t is number => Number.isFinite(t));
      const maxTemp = temps.length > 0 ? Math.max(...temps) : 0;
      this.navBar?.setMotorTemp(maxTemp);
      this.mappingPage?.setMotorTemp(maxTemp);
    }

    if (d.bms_state) {
      const bms = d.bms_state as Record<string, unknown>;
      this.logBmsSample(bms);
      if (typeof bms.soc === 'number') {
        this.robotState.batteryPercent = bms.soc;
        this.navBar?.setBattery(bms.soc);
        this.mappingPage?.setBattery(bms.soc);
      }
      if (typeof bms.current === 'number') this.robotState.batteryCurrent = bms.current;
      if (typeof bms.cycle === 'number') this.robotState.batteryCycles = bms.cycle;

      // Voltage + temperatures shape diverges per family — see comments
      // below for the verified payload shapes.
      if (cloudApi.connectFamily === 'G1') {
        // G1 rt/lf/bmsstate: pack_voltage / bat_voltage in mV, temps in
        // a `temperature` array (BatteryDataViewmodel.kt).
        const pack = typeof bms.pack_voltage === 'number' ? bms.pack_voltage : undefined;
        const bat  = typeof bms.bat_voltage  === 'number' ? bms.bat_voltage  : undefined;
        if (pack !== undefined) {
          this.robotState.batteryPackVoltage = pack;
          this.robotState.batteryVoltage = pack;
        }
        if (bat !== undefined) this.robotState.batteryBatVoltage = bat;
        const tempsArr = Array.isArray(bms.temperature) ? bms.temperature
                       : Array.isArray(bms.temps)       ? bms.temps
                       : null;
        if (tempsArr) {
          const numericTemps = (tempsArr as unknown[]).filter((t): t is number => typeof t === 'number');
          this.robotState.batteryTemps = numericTemps;
          if (numericTemps.length > 0) this.robotState.batteryTemp = numericTemps[0];
        }
      } else {
        // Go2 verified live capture: bms_state has no voltage field at
        // all. The pack voltage rides at the lowstate root as `power_v`
        // (in *volts*, not mV — convert so the status page's /1000
        // formatter still works). Battery temps come from `bq_ntc`
        // (BQ fuel-gauge NTCs) and `mcu_ntc` (MCU NTCs).
        if (typeof d.power_v === 'number') {
          this.robotState.batteryVoltage = d.power_v * 1000;
        }
        const bq  = Array.isArray(bms.bq_ntc)  ? (bms.bq_ntc  as unknown[]).filter((t): t is number => typeof t === 'number') : [];
        const mcu = Array.isArray(bms.mcu_ntc) ? (bms.mcu_ntc as unknown[]).filter((t): t is number => typeof t === 'number') : [];
        const all = [...bq, ...mcu];
        if (all.length > 0) this.robotState.batteryTemp = Math.max(...all);
      }
    }

    if (d.foot_force) this.robotState.footForce = d.foot_force;
    if (d.imu_state?.temperature !== undefined) {
      this.robotState.imuTemp = d.imu_state.temperature;
      this.navBar?.setBodyTemp(d.imu_state.temperature);
    }
    // On G1 the lowstate's imu_state IS the torso ("Body") IMU. The
    // Status panel's Body IMU section reads from robotState.bodyImu, so
    // mirror the rpy+temp here. (On Go2 we don't expose a separate Body
    // section, so populating this is harmless.)
    if (cloudApi.connectFamily === 'G1' && d.imu_state) {
      const im = d.imu_state as { rpy?: number[]; temperature?: number };
      const rpy = (im.rpy && im.rpy.length >= 3 ? im.rpy : [0, 0, 0]).slice(0, 3) as [number, number, number];
      this.robotState.bodyImu = { rpy, temp: typeof im.temperature === 'number' ? im.temperature : 0 };
    }

    // Update status page if visible
    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
    }
  }

  /** Log the raw bms_state payload on first arrival and once every
   *  ~5 s after that — first frame prints all keys + the full JSON so
   *  we can verify which voltage / temperature field a given firmware
   *  uses; subsequent dumps are one-line samples. */
  private logBmsSample(bms: Record<string, unknown>): void {
    const now = Date.now();
    if (!this.bmsLogged) {
      this.bmsLogged = true;
      this.bmsLogLast = now;
      console.log(`[bms] first frame — family=${cloudApi.connectFamily} keys:`, Object.keys(bms));
      console.log('[bms] first frame — full payload:', JSON.stringify(bms, null, 2));
      return;
    }
    if (now - this.bmsLogLast < 5000) return;
    this.bmsLogLast = now;
    console.log('[bms] sample:', JSON.stringify(bms));
  }

  // G1's pelvis ("Crotch") IMU rides on rt/lf/secondary_imu as a flat
  // G1ImuState payload (rpy + temperature, etc.). The torso ("Body")
  // IMU is whatever already lives in lowstate.imu_state — populated by
  // handleLowState. See BaseInfoViewModel.kt:195 in the decompiled apk.
  private handleSecondaryImu(data: unknown): void {
    const i = data as { rpy?: number[]; temperature?: number };
    const rpy = (i.rpy && i.rpy.length >= 3 ? i.rpy : [0, 0, 0]).slice(0, 3) as [number, number, number];
    this.robotState.crotchImu = { rpy, temp: typeof i.temperature === 'number' ? i.temperature : 0 };
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
    this.mappingPage?.setNetworkType(type);
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
    const d = data as {
      header?: { identity?: { id?: number; api_id?: number }; status?: { code?: number } };
      data?: string;
    };
    const code = d.header?.status?.code;
    const id = d.header?.identity?.id;
    const scriptLine = id !== undefined ? this.bashrunnerPending.get(id) : undefined;
    if (id !== undefined) this.bashrunnerPending.delete(id);
    const scriptName = scriptLine ? scriptLine.split(' ')[0] : '?';

    if (code !== 0 || typeof d.data !== 'string') {
      if (scriptLine) console.warn(`[bashrunner] ${scriptName} failed (code=${code})`);
      return;
    }

    let info: unknown;
    let result: string | undefined;
    try {
      const parsed = JSON.parse(d.data) as { result?: string; info?: unknown; type?: string };
      info = parsed.info;
      result = parsed.result;
    } catch {
      info = d.data;
    }

    // Route by script. The robot replies with `info` shaped per script:
    //   * get_ip_address.sh        -> { wlan0: "...", wlan1: "..." }
    //   * get_hardware_version.sh  -> "10"   (formatted as "2.<n/10>.<n%10>")
    //   * get_software_version.sh  -> "1.4.6"
    //   * get_whole_packet_version.sh -> firmware string
    //
    // Go2 firmware doesn't reliably echo the request `id` back, so script
    // correlation can fail and `scriptName` ends up as '?'. In that case
    // — and on the explicit whole_packet_version path — populate
    // firmwareVersion. This matches main's universal "any bashrunner
    // success → firmware version" behaviour and restores Go2.
    switch (scriptName) {
      case 'get_ip_address.sh': {
        if (info && typeof info === 'object') {
          const ips = info as { wlan0?: string; wlan1?: string; eth0?: string };
          const ip = ips.wlan0 || ips.wlan1 || ips.eth0 || '';
          if (ip) this.robotState.ipAddress = ip;
        }
        break;
      }
      case 'get_hardware_version.sh': {
        // BaseInfoViewModel.kt:232 formats as "2" + (n/10) + "." + (n%10),
        // i.e. info=10 -> "2.1.0", info=12 -> "2.1.2".
        const raw = typeof info === 'string' ? info : typeof info === 'number' ? String(info) : '';
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n)) {
          this.robotState.hardwareVersion = `2.${Math.floor(n / 10)}.${n % 10}`;
        }
        break;
      }
      case 'get_software_version.sh': {
        if (typeof info === 'string') this.robotState.softwareVersion = info;
        break;
      }
      case 'get_whole_packet_version.sh':
      default: {
        const v = typeof info === 'string' ? info : (result || (typeof d.data === 'string' ? d.data : ''));
        if (v) this.robotState.firmwareVersion = v;
        break;
      }
    }

    if (this.currentScreen === 'status' && this.statusPage) {
      this.statusPage.update(this.robotState);
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
        this.mappingPage?.setStream(stream);
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
        // Remote: kick off WebRTC immediately — same UX as Local/AP. The
        // hub is shown in the onValidated callback.
        if (!config.token) throw new Error('Not logged in');
        if (!config.serialNumber) throw new Error('No robot selected');
        this.webrtc = await connectRemote(config.serialNumber, config.token, callbacks, onStep);
      } else {
        if (!config.ip) throw new Error('IP address required');
        this.webrtc = await connectLocal(config.ip, config.mode, callbacks, onStep, {
          sn: config.serialNumber,
          promptKey: (sn) => promptAesKey(sn),
        });
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
    const wasRemote = this.connectionConfig?.mode === 'STA-T';

    this.stopJoystickLoop();
    this.setRelay(false);
    this.stopBgNoise();
    this.dataHandler?.destroy();
    this.dataHandler = null;
    this.webrtc?.close();
    this.webrtc = null;
    this.videoStream = null;
    this.videoBg = null;
    this.noiseBgCanvas = null;
    this.pipCamera?.destroy();
    this.pipCamera = null;
    this.navBar = null;
    this.actionBar = null;
    this.settingBar = null;
    this.statusPage = null;
    this.servicesPage = null;
    this.mappingPage?.destroy();
    this.mappingPage = null;
    this.accountPage?.destroy();
    this.accountPage = null;
    this.serviceEntries = [];
    if (this.serviceReportTimer) {
      clearInterval(this.serviceReportTimer);
      this.serviceReportTimer = null;
    }
    this.scene3d?.destroy();
    this.scene3d = null;
    this.viewMode = 'three';

    // Auto-connect means the hub is always backed by an active WebRTC
    // session. On disconnect (any mode) drop back to landing — re-entering
    // Connect → robot will re-establish the session.
    void wasRemote;
    this.connectionConfig = null;
    this.showLandingScreen();
  }
}

import { SlamScene, type ClickMode } from '../scene/slam-scene';
import { RTC_TOPIC } from '../../protocol/topics';
import SlamWorker from '../../workers/slam-worker?worker';
import { putBundle, getBundle, deleteBundle, bytesToBase64, base64ToBytes, bundleToZip, zipToBundle, downloadBlob, type MapBundle } from '../../storage/map-pcd-store';
import { theme } from '../theme';
import type { BluetoothStatus } from './bt-status-icon';
import { PipCamera } from './pip-camera';

const BT_SVG = (color: string): string =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>`;
const SUN_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFB74D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const MOON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3bb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

type SlamState = 'idle' | 'mapping' | 'localized' | 'navigating' | 'patrolling';

// Catalog of every endpoint discovered in the uslam_server binary + APK.
// Each item: command string the user edits + DDS topic it gets published on.
const USLAM = 'rt/uslam/client_command';
const COMMAND_TEMPLATES: Array<{ label: string; items: Array<{ cmd: string; topic: string }> }> = [
  { label: 'Mapping', items: [
    { cmd: 'mapping/start', topic: USLAM },
    { cmd: 'mapping/stop', topic: USLAM },
    { cmd: 'mapping/cancel', topic: USLAM },
    { cmd: 'mapping/get_status', topic: USLAM },
    { cmd: 'mapping/run_mapping_process', topic: USLAM },
    { cmd: 'mapping/get_cloud_map', topic: USLAM },
    { cmd: 'mapping/set_map_pose/{x}/{y}/{z}/{qx}/{qy}/{qz}/{qw}', topic: USLAM },
  ]},
  { label: 'Localization', items: [
    { cmd: 'localization/start', topic: USLAM },
    { cmd: 'localization/stop', topic: USLAM },
    { cmd: 'localization/get_status', topic: USLAM },
    { cmd: 'localization/set_initial_pose/{x}/{y}/{yaw}', topic: USLAM },
    { cmd: 'localization/set_initial_pose_type/{type}', topic: USLAM },
  ]},
  { label: 'Navigation', items: [
    { cmd: 'navigation/start', topic: USLAM },
    { cmd: 'navigation/stop', topic: USLAM },
    { cmd: 'navigation/get_status', topic: USLAM },
    { cmd: 'navigation/set_goal_pose/{x}/{y}/{yaw}', topic: USLAM },
  ]},
  { label: 'Patrol', items: [
    { cmd: 'patrol/start', topic: USLAM },
    { cmd: 'patrol/stop', topic: USLAM },
    { cmd: 'patrol/pause', topic: USLAM },
    { cmd: 'patrol/go', topic: USLAM },
    { cmd: 'patrol/get_status', topic: USLAM },
    { cmd: 'patrol/get_patrol_points', topic: USLAM },
    { cmd: 'patrol/add_patrol_point/{x}/{y}/{yaw}', topic: USLAM },
    { cmd: 'patrol/clear_all_patrol_points', topic: USLAM },
    { cmd: 'patrol/clear_all_patrol_areas', topic: USLAM },
    { cmd: 'patrol/load_patrol_points_from_file/{path}', topic: USLAM },
    { cmd: 'patrol/set_patrol_number_limit/{n}', topic: USLAM },
    { cmd: 'patrol/set_patrol_time_limit/{seconds}', topic: USLAM },
    { cmd: 'patrol/set_total_time_limit/{seconds}', topic: USLAM },
    { cmd: 'patrol/set_charge_time_limit/{seconds}', topic: USLAM },
    { cmd: 'patrol/set_bms_soc_limit/{min}/{max}', topic: USLAM },
    { cmd: 'patrol/clear_user_config', topic: USLAM },
  ]},
  { label: 'Autocharge', items: [
    { cmd: 'autocharge/start', topic: USLAM },
    { cmd: 'autocharge/stop', topic: USLAM },
    { cmd: 'autocharge/get_status', topic: USLAM },
    { cmd: 'autocharge/set_plate_distance/{meters}', topic: USLAM },
    { cmd: 'autocharge/go_back_charge_and_stop_patrol', topic: USLAM },
    { cmd: 'autocharge/go_to_charge_and_stop_patrol', topic: USLAM },
  ]},
  { label: 'Frontend (LiDAR pipeline)', items: [
    { cmd: 'frontend/start', topic: USLAM },
    { cmd: 'frontend/stop', topic: USLAM },
    { cmd: 'frontend/restart', topic: USLAM },
    { cmd: 'frontend/get_status', topic: USLAM },
  ]},
  { label: 'Control', items: [
    { cmd: 'control/start', topic: USLAM },
    { cmd: 'control/stop', topic: USLAM },
    { cmd: 'control/get_status', topic: USLAM },
    { cmd: 'control/stand_up', topic: USLAM },
    { cmd: 'control/stand_down', topic: USLAM },
    { cmd: 'control/recovery_stand', topic: USLAM },
    { cmd: 'control/move_velocity/{vx}/{vy}/{vyaw}', topic: USLAM },
    { cmd: 'control/stop_move', topic: USLAM },
    { cmd: 'control/recv_cmd/{cmd}', topic: USLAM },
  ]},
  { label: 'Common / Map', items: [
    { cmd: 'common/get_map_id', topic: USLAM },
    { cmd: 'common/set_map_id/{id}', topic: USLAM },
    { cmd: 'common/get_map_file', topic: USLAM },
    { cmd: 'common/enable_log_to_file', topic: USLAM },
    { cmd: 'common/disable_log_to_file', topic: USLAM },
    { cmd: 'common/enable_joystick_control', topic: USLAM },
    { cmd: 'common/disable_joystick_control', topic: USLAM },
  ]},
  { label: 'LiDAR hardware', items: [
    { cmd: 'ON', topic: 'rt/utlidar/switch' },
    { cmd: 'OFF', topic: 'rt/utlidar/switch' },
  ]},
];

// USLAM topics subscribed on enter / unsubscribed on leave (matching APK).
// LOW_STATE is intentionally NOT here — it's globally subscribed by
// app.ts::enableVideoAndSubscribe and shared with the NavBar; unsubscribing
// it on mapping-leave would break the navbar's battery feed.
const BASE_USLAM_TOPICS = [
  RTC_TOPIC.USLAM_SERVER_LOG,
  RTC_TOPIC.USLAM_CLOUD_WORLD,
  RTC_TOPIC.USLAM_ODOM,
  RTC_TOPIC.USLAM_CLOUD_MAP,
  RTC_TOPIC.USLAM_GRID_MAP,
];

// Subscribed only after localization succeeds; unsubscribed when localization
// stops or the user leaves the page (matches APK's deferred-subscription).
const LOC_USLAM_TOPICS = [
  RTC_TOPIC.USLAM_LOC_CLOUD,
  RTC_TOPIC.USLAM_LOC_ODOM,
  RTC_TOPIC.USLAM_NAV_PATH,
];

export class MappingPage {
  private container: HTMLElement;
  private slamScene: SlamScene | null = null;
  private onBack: () => void;
  private publish: (topic: string, data: unknown) => void;
  private subscribe: (topic: string) => void;
  private unsubscribe: (topic: string) => void;

  private state: SlamState = 'idle';
  private stateEl!: HTMLElement;
  private subStateEl!: HTMLElement;
  private logEl!: HTMLElement;
  private activeClickBtn: HTMLButtonElement | null = null;
  private patrolCount = 0;
  private patrolPoints: Array<{ x: number; y: number; yaw: number }> = [];
  private slamWorker: Worker | null = null;
  private workerReady = false;
  private requestFile: ((path: string, cb: (data: string | null) => void) => void) | null = null;
  private pushFile: ((path: string, b64: string, onProgress?: (frac: number) => void) => Promise<void>) | null = null;
  private savedMapsEl!: HTMLElement;
  private currentMapId = '';
  // The robot's mapping/stop does NOT mint a fresh ID; map_id.txt only changes
  // on common/set_map_id. So we mint client-side at "New Map" and push it to
  // the robot via set_map_id after mapping/stop/success. This mirrors the APK's
  // post-stop set_map_id call (the APK gets its ID from a native bridge instead).
  private pendingNewMapId = '';
  private pendingSaveAfterStop = false;
  private pendingSaveTimer: number | null = null;
  // ID of the map whose files are currently in the robot's single slot. Set
  // when we know the slot's contents match a known map (after a fresh save or
  // after a successful upload-then-set_map_id). Cleared by mapping/start since
  // that overwrites the slot.
  private robotSlotMapId = '';

  // Flow gating state
  private mapLoaded = false;
  private localized = false;
  private localizingInProgress = false;
  private navigationActive = false;
  private autoChargeOnReach = false;
  private autoChargeRetries = 0;
  private static AUTO_CHARGE_MAX_RETRIES = 5;

  // Patrol limits — patrol/set_*_limit only succeeds when the patrol module
  // is in INITIALIZE state (i.e. after patrol/start). When the user clicks
  // Apply outside a patrol session the live send fails, so we also persist
  // the value here and re-send everything from executePatrol on the next run.
  private patrolConfig = {
    // Per-patrol-cycle time. When the robot finishes a cycle within this
    // window, the binary fires REACH_PATROL_TIME_LIMIT → NEED_CHARGE →
    // NAVIGATE_TO_CHARGE_BOARD even if the battery is fine. -1 = unlimited
    // (no trigger), which is what we want for users who don't want auto
    // docking on a fixed schedule.
    patrolTime: -1,
    totalMissionTime: -1,
    chargeCycleTime: -1,
    loopCount: -1,
    bmsSocMin: 10,
    bmsSocMax: 80,
  };
  private patrolPaused = false;
  private patrolPauseBtn!: HTMLButtonElement;
  private navMode: 'goal' | 'patrol' = 'goal';
  private goalPanel!: HTMLElement;
  private patrolPanel!: HTMLElement;
  private goalModeBtn!: HTMLButtonElement;
  private patrolModeBtn!: HTMLButtonElement;

  // Section references for enabling/disabling
  private locSection!: HTMLElement;
  private navSection!: HTMLElement;
  private autochargeSection!: HTMLElement;
  private batteryFill!: HTMLElement;
  private batteryText!: HTMLElement;
  private netTypeEl!: HTMLElement;
  private motorTempEl!: HTMLElement;
  private wifiIconEl!: HTMLImageElement;
  private btIconWrap!: HTMLElement;
  private themeIconWrap!: HTMLElement;
  private onBtClick: (() => void) | null = null;
  private unsubTheme: (() => void) | null = null;
  private pipCamera: PipCamera | null = null;
  private locHint!: HTMLElement;
  private navHint!: HTMLElement;
  private navControlsEl!: HTMLElement;
  private navStartBtn!: HTMLButtonElement;
  private navStopBtn!: HTMLButtonElement;

  // Localization button references
  private locStartBtn!: HTMLButtonElement;
  private locSetPoseBtn!: HTMLButtonElement;
  private locAbortBtn!: HTMLButtonElement;
  private locStatusEl!: HTMLElement;

  constructor(
    parent: HTMLElement,
    onBack: () => void,
    onPublish: (topic: string, data: unknown) => void,
    onSubscribe: (topic: string) => void,
    onUnsubscribe: (topic: string) => void,
    onRequestFile?: (path: string, cb: (data: string | null) => void) => void,
    onPushFile?: (path: string, b64: string, onProgress?: (frac: number) => void) => Promise<void>,
    onBtClick?: () => void,
  ) {
    this.onBack = onBack;
    this.publish = onPublish;
    this.subscribe = onSubscribe;
    this.unsubscribe = onUnsubscribe;
    this.requestFile = onRequestFile ?? null;
    this.pushFile = onPushFile ?? null;
    this.onBtClick = onBtClick ?? null;

    this.container = document.createElement('div');
    this.container.className = 'mapping-page';

    // Header
    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    // onBack flows through app.ts → goToHub() → mappingPage.destroy(), and
    // destroy() runs cleanup(). Don't unsubscribe here too or each topic gets
    // unsubscribed twice.
    backBtn.addEventListener('click', () => onBack());
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = '3D LiDAR Mapping';
    header.appendChild(title);

    // Right-side cluster — mirrors NavBar exactly: motor temp / divider /
    // battery / divider / net type / WiFi icon / theme / BT. The persistent
    // body-mounted icons are hidden by app.ts when this page is active.
    const cluster = document.createElement('div');
    cluster.className = 'mapping-header-cluster';
    cluster.innerHTML = `
      <span class="motor-temp-label"></span>
      <div class="nav-divider"></div>
      <div class="battery-icon">
        <div class="battery-fill-box">
          <div class="battery-fill"></div>
          <span class="battery-text">--%</span>
        </div>
      </div>
      <div class="nav-divider"></div>
      <span class="net-type-label"></span>
      <img class="wifi-icon" src="/sprites/icon_wifi.png" alt="WiFi" />
      <div class="nav-theme-icon" title="Toggle theme"></div>
      <div class="nav-bt-icon" title="Bluetooth: not connected">${BT_SVG('#b0b3bb')}</div>
    `;
    header.appendChild(cluster);
    this.batteryFill = cluster.querySelector('.battery-fill') as HTMLElement;
    this.batteryText = cluster.querySelector('.battery-text') as HTMLElement;
    this.netTypeEl = cluster.querySelector('.net-type-label') as HTMLElement;
    this.motorTempEl = cluster.querySelector('.motor-temp-label') as HTMLElement;
    this.wifiIconEl = cluster.querySelector('.wifi-icon') as HTMLImageElement;
    this.themeIconWrap = cluster.querySelector('.nav-theme-icon') as HTMLElement;
    this.btIconWrap = cluster.querySelector('.nav-bt-icon') as HTMLElement;

    // Theme toggle — same behaviour as NavBar.
    this.themeIconWrap.addEventListener('click', () => theme().toggle());
    const renderTheme = (t: 'dark' | 'light'): void => {
      this.themeIconWrap.innerHTML = t === 'dark' ? MOON_SVG : SUN_SVG;
      this.themeIconWrap.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    };
    renderTheme(theme().theme);
    this.unsubTheme = theme().onChange((t) => renderTheme(t));

    // BT icon — hover effect + click forwards to the popover toggle.
    this.btIconWrap.addEventListener('click', () => this.onBtClick?.());

    this.container.appendChild(header);

    // Status stepper (horizontal flow under the header)
    this.stateEl = document.createElement('div');
    this.stateEl.className = 'mapping-stepper';
    this.container.appendChild(this.stateEl);
    this.subStateEl = document.createElement('div');
    this.subStateEl.className = 'mapping-substate';
    this.subStateEl.style.display = 'none';
    this.container.appendChild(this.subStateEl);
    this.updateStateDisplay();

    // Body: viewport + sidebar
    const body = document.createElement('div');
    body.className = 'mapping-body';

    // Left sidebar — diagnostics (Send Command + Server Log)
    const leftSidebar = document.createElement('div');
    leftSidebar.className = 'mapping-sidebar mapping-sidebar-left';
    this.buildLeftSidebar(leftSidebar);
    body.appendChild(leftSidebar);

    // 3D Viewport
    const viewport = document.createElement('div');
    viewport.className = 'mapping-viewport';
    const canvas = document.createElement('canvas');
    canvas.className = 'mapping-canvas';
    viewport.appendChild(canvas);
    body.appendChild(viewport);

    // Draggable PiP video feed overlaid on the 3D viewport — same component
    // and styling as the control screen.
    this.pipCamera = new PipCamera(viewport);

    // Right sidebar — controls
    const sidebar = document.createElement('div');
    sidebar.className = 'mapping-sidebar mapping-sidebar-right';
    this.buildSidebar(sidebar);
    body.appendChild(sidebar);

    this.container.appendChild(body);
    parent.appendChild(this.container);

    // Init scene after DOM is attached
    requestAnimationFrame(() => {
      this.slamScene = new SlamScene(canvas);
      this.slamScene.onPoseSet = (mode, x, y, yaw) => this.handlePoseSet(mode, x, y, yaw);
    });

    // Init SLAM worker (libvoxel.wasm for point cloud processing)
    const worker = new SlamWorker();
    this.slamWorker = worker;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        this.workerReady = true;
        console.log('[slam] Worker ready');
      } else if (msg.type === 'newMap') {
        const { output, directOutput } = msg.data as {
          output: Float32Array;
          directOutput: Float32Array;
        };
        this.slamScene?.updatePointCloud(output);
        this.slamScene?.updateLaserCloud(directOutput);
      } else if (msg.type === 'preview') {
        const { points } = msg.data as { points: Float32Array };
        this.slamScene?.updateLaserCloud(points);
      } else if (msg.type === 'navigation-path') {
        const { points } = msg.data as { points: Float32Array };
        this.slamScene?.updateNavPath(points);
      }
    };

    // Subscribe base topics on entry (localization topics deferred until success)
    for (const topic of BASE_USLAM_TOPICS) {
      this.subscribe(topic);
    }

    // Apply initial flow gating
    this.updateFlowGating();

    // Probe robot state on entry: if localization+patrol are already active,
    // restore the UI to that mode so the user can pause/stop without re-doing
    // setup. Mirrors the APK's `judgeRobotStatusIsPatrol` preload.
    setTimeout(() => { void this.preloadRobotState(); }, 500);
  }

  private buildSidebar(sidebar: HTMLElement): void {
    // Status is rendered as a horizontal stepper under the header — see ctor.

    // ── Step 1: Map ──
    sidebar.appendChild(this.buildSection('Step 1: Mapping', (body) => {
      // ── Create New ──
      const createLabel = document.createElement('div');
      createLabel.className = 'mapping-subsection-title';
      createLabel.textContent = 'Create New';
      body.appendChild(createLabel);

      const row = document.createElement('div');
      row.className = 'mapping-btn-row';
      row.appendChild(this.btn('New Map', 'mapping-btn-start', () => {
        this.slamScene?.clearAll();
        this.slamWorker?.postMessage('clear');
        this.currentMapId = '';
        this.pendingNewMapId = MappingPage.generateMapId();
        this.pendingSaveAfterStop = false;
        // mapping/start overwrites the robot's slot — invalidate the marker.
        this.robotSlotMapId = '';
        if (this.pendingSaveTimer !== null) { clearTimeout(this.pendingSaveTimer); this.pendingSaveTimer = null; }
        this.addLog(`New map ID minted: ${this.pendingNewMapId}`);
        this.sendCmd('mapping/start');
        this.setState('mapping');
      }));
      row.appendChild(this.btn('Stop & Save', 'mapping-btn-stop', () => {
        this.sendCmd('mapping/stop');
        this.setState('idle');
      }));
      body.appendChild(row);

      // ── Saved Maps ──
      const savedHeader = document.createElement('div');
      savedHeader.className = 'mapping-saved-header';
      savedHeader.style.marginTop = '10px';
      const savedLabel = document.createElement('div');
      savedLabel.className = 'mapping-subsection-title';
      savedLabel.textContent = 'Saved Maps';
      savedHeader.appendChild(savedLabel);
      const importBtn = document.createElement('button');
      importBtn.className = 'mapping-btn mapping-btn-sm';
      importBtn.textContent = 'Import .zip';
      importBtn.addEventListener('click', () => this.importMapZip());
      savedHeader.appendChild(importBtn);
      body.appendChild(savedHeader);

      this.savedMapsEl = document.createElement('div');
      this.savedMapsEl.className = 'mapping-saved-list';
      body.appendChild(this.savedMapsEl);
      this.renderSavedMaps();

      // Hidden map ID input (used internally by Get Current Map ID)
      const mapIdInput = document.createElement('input');
      mapIdInput.type = 'hidden';
      mapIdInput.id = 'map-id-input';
      body.appendChild(mapIdInput);
    }));

    // ── Step 2: Localization ──
    this.locSection = this.buildSection('Step 2: Localization', (body) => {
      this.locHint = document.createElement('div');
      this.locHint.className = 'mapping-hint';
      this.locHint.textContent = 'Create or load a map first';
      body.appendChild(this.locHint);

      // Status feedback
      this.locStatusEl = document.createElement('div');
      this.locStatusEl.className = 'mapping-loc-status';
      this.locStatusEl.style.display = 'none';
      body.appendChild(this.locStatusEl);

      // Start Localization (green) — tries auto-localization first
      this.locStartBtn = this.btn('Start Localization', 'mapping-btn-start', () => {
        this.localizingInProgress = true;
        this.locStartBtn.style.display = 'none';
        this.locAbortBtn.style.display = '';
        this.locSetPoseBtn.classList.remove('mapping-btn-highlight');
        this.setLocStatus('Attempting auto-localization...', '#6879e4');
        this.sendCmd('localization/start');
      });
      body.appendChild(this.locStartBtn);

      // Set Initial Pose — subtle by default, highlighted after auto-localization fails
      this.locSetPoseBtn = this.clickModeBtn('Set Initial Pose (hold on map, drag to aim)', 'initial_pose');
      body.appendChild(this.locSetPoseBtn);

      // Abort / Stop (red)
      this.locAbortBtn = this.btn('Abort Localization', 'mapping-btn-stop', () => {
        this.sendCmd('localization/stop');
        this.localizingInProgress = false;
        this.localized = false;
        this.locAbortBtn.style.display = 'none';
        this.locStartBtn.style.display = '';
        this.setLocStatus('', '');
        this.setState('idle');
        this.updateFlowGating();
      });
      this.locAbortBtn.style.display = 'none';
      body.appendChild(this.locAbortBtn);
    });
    sidebar.appendChild(this.locSection);

    // ── Step 3: Navigation & Patrol ──
    this.navSection = this.buildSection('Step 3: Navigation', (body) => {
      this.navHint = document.createElement('div');
      this.navHint.className = 'mapping-hint';
      this.navHint.textContent = 'Localize the robot first';
      body.appendChild(this.navHint);

      // Start/Stop Navigation toggle
      const navToggleRow = document.createElement('div');
      navToggleRow.className = 'mapping-btn-row';
      this.navStartBtn = this.btn('Start Navigation', 'mapping-btn-start', () => {
        this.sendCmd('navigation/start');
        this.navigationActive = true;
        this.setState('navigating');
        this.updateNavControls();
        this.addLog('Navigation activated');
      });
      navToggleRow.appendChild(this.navStartBtn);
      this.navStopBtn = this.btn('Stop Navigation', 'mapping-btn-stop', () => {
        this.sendCmd('navigation/stop');
        this.slamScene?.clearNavPath();
        this.slamScene?.clearGoalMarker();
        this.navigationActive = false;
        this.setState('localized');
        this.updateNavControls();
        this.addLog('Navigation stopped');
      });
      this.navStopBtn.style.display = 'none';
      navToggleRow.appendChild(this.navStopBtn);
      body.appendChild(navToggleRow);

      // Controls container (greyed out until navigation started)
      this.navControlsEl = document.createElement('div');
      this.navControlsEl.className = 'mapping-nav-controls mapping-section-disabled';

      // ── Mode tabs ──
      const tabRow = document.createElement('div');
      tabRow.className = 'mapping-btn-row';
      this.goalModeBtn = this.btn('Go to Goal', 'mapping-btn-mode active', () => {
        this.setNavMode('goal');
      });
      this.patrolModeBtn = this.btn('Patrol', 'mapping-btn-mode', () => {
        this.setNavMode('patrol');
      });
      tabRow.appendChild(this.goalModeBtn);
      tabRow.appendChild(this.patrolModeBtn);
      this.navControlsEl.appendChild(tabRow);

      // ── Go to Goal panel ──
      this.goalPanel = document.createElement('div');
      this.goalPanel.className = 'mapping-nav-panel';
      this.goalPanel.appendChild(this.clickModeBtn('Set Goal (hold on map, drag to aim)', 'goal'));
      this.navControlsEl.appendChild(this.goalPanel);

      // ── Patrol panel ──
      this.patrolPanel = document.createElement('div');
      this.patrolPanel.className = 'mapping-nav-panel';
      this.patrolPanel.style.display = 'none';
      this.patrolPanel.appendChild(this.clickModeBtn('Add Waypoint (hold on map, drag to aim)', 'patrol'));
      this.patrolPanel.appendChild(this.btn('Clear All Waypoints', 'mapping-btn-warn', () => {
        this.sendCmd('patrol/clear_all_patrol_points');
        this.slamScene?.clearPatrolMarkers();
        this.patrolPoints = [];
        this.patrolCount = 0;
        this.addLog('All patrol waypoints cleared');
      }));
      const patrolCtrlRow = document.createElement('div');
      patrolCtrlRow.className = 'mapping-btn-row';
      patrolCtrlRow.appendChild(this.btn('Execute Patrol', 'mapping-btn-start', () => {
        this.executePatrol();
      }));
      this.patrolPauseBtn = this.btn('Pause', 'mapping-btn-warn', () => {
        if (this.patrolPaused) {
          this.sendCmd('patrol/go');
        } else {
          this.sendCmd('patrol/pause');
        }
      });
      patrolCtrlRow.appendChild(this.patrolPauseBtn);
      this.patrolPanel.appendChild(patrolCtrlRow);
      this.patrolPanel.appendChild(this.btn('Stop Patrol', 'mapping-btn-stop', () => {
        this.sendCmd('patrol/stop');
        this.patrolPaused = false;
        this.setState('localized');
      }));

      // Patrol limits sub-panel (per-segment / total / charge time, in seconds)
      const limitsLabel = document.createElement('div');
      limitsLabel.className = 'mapping-subsection-title';
      limitsLabel.textContent = 'Limits';
      limitsLabel.style.marginTop = '10px';
      this.patrolPanel.appendChild(limitsLabel);

      // Single-value limit row (number → publish `<cmdPrefix>/{n}`).
      const mkLimitRow = (
        label: string,
        defaultVal: number,
        cmdPrefix: string,
        info: string,
        onSet: (v: number) => void,
        opts?: { allowMinusOne?: boolean; min?: number },
      ): HTMLElement => {
        const row = document.createElement('div');
        row.className = 'mapping-cmd-row';
        const labelLine = document.createElement('div');
        labelLine.className = 'mapping-cmd-labelline';
        const lbl = document.createElement('label');
        lbl.className = 'mapping-cmd-label';
        lbl.textContent = label;
        labelLine.appendChild(lbl);
        labelLine.appendChild(this.mkInfoBtn(info));
        row.appendChild(labelLine);
        const inner = document.createElement('div');
        inner.className = 'mapping-btn-row';
        const input = document.createElement('input');
        input.className = 'mapping-input';
        input.type = 'number';
        input.min = String(opts?.min ?? 1);
        input.placeholder = String(defaultVal);
        input.value = String(defaultVal);
        inner.appendChild(input);
        const apply = this.btn('Apply', '', () => {
          const raw = input.value.trim() === '' ? String(defaultVal) : input.value;
          const v = parseInt(raw, 10);
          if (!Number.isFinite(v)) { this.addLog(`${label}: enter a number`); return; }
          const minV = opts?.min ?? 1;
          if (v < minV && !(opts?.allowMinusOne && v === -1)) {
            this.addLog(`${label}: must be ≥ ${minV}${opts?.allowMinusOne ? ' (or -1 for unlimited)' : ''}`);
            return;
          }
          // Persist locally — applied on every executePatrol so it sticks
          // even though the live set fails when the patrol module is idle.
          onSet(v);
          this.sendCmd(`${cmdPrefix}/${v}`);
          this.addLog(`${label}: saved (live update only succeeds during patrol; will be re-sent on Execute Patrol)`);
        });
        apply.style.width = 'auto';
        apply.style.minWidth = '64px';
        inner.appendChild(apply);
        row.appendChild(inner);
        return row;
      };

      // Two-value limit row (publishes `<cmdPrefix>/{a}/{b}`). Inputs on one
      // line, Apply button on the next so the 380 px sidebar isn't cramped.
      const mkTwoLimitRow = (
        label: string,
        defA: number,
        defB: number,
        cmdPrefix: string,
        info: string,
        onSet: (a: number, b: number) => void,
        opts?: { min?: number; max?: number },
      ): HTMLElement => {
        const row = document.createElement('div');
        row.className = 'mapping-cmd-row';
        const labelLine = document.createElement('div');
        labelLine.className = 'mapping-cmd-labelline';
        const lbl = document.createElement('label');
        lbl.className = 'mapping-cmd-label';
        lbl.textContent = label;
        labelLine.appendChild(lbl);
        labelLine.appendChild(this.mkInfoBtn(info));
        row.appendChild(labelLine);
        const inputs = document.createElement('div');
        inputs.className = 'mapping-btn-row';
        const a = document.createElement('input');
        a.className = 'mapping-input';
        a.type = 'number';
        if (opts?.min !== undefined) a.min = String(opts.min);
        if (opts?.max !== undefined) a.max = String(opts.max);
        a.placeholder = String(defA);
        a.value = String(defA);
        const b = document.createElement('input');
        b.className = 'mapping-input';
        b.type = 'number';
        if (opts?.min !== undefined) b.min = String(opts.min);
        if (opts?.max !== undefined) b.max = String(opts.max);
        b.placeholder = String(defB);
        b.value = String(defB);
        inputs.appendChild(a);
        inputs.appendChild(b);
        row.appendChild(inputs);
        const apply = this.btn('Apply', '', () => {
          const av = parseInt(a.value.trim() === '' ? String(defA) : a.value, 10);
          const bv = parseInt(b.value.trim() === '' ? String(defB) : b.value, 10);
          if (!Number.isFinite(av) || !Number.isFinite(bv)) { this.addLog(`${label}: enter both values`); return; }
          if (av >= bv) { this.addLog(`${label}: min must be < max`); return; }
          onSet(av, bv);
          this.sendCmd(`${cmdPrefix}/${av}/${bv}`);
          this.addLog(`${label}: saved (live update only succeeds during patrol; will be re-sent on Execute Patrol)`);
        });
        row.appendChild(apply);
        return row;
      };

      // Defaults below mirror /unitree/.../config.yaml or the executePatrol fallback.
      this.patrolPanel.appendChild(mkLimitRow(
        'Patrol cycle time (s)', -1, 'patrol/set_patrol_time_limit',
        'Maximum seconds for one full patrol cycle (one loop through all waypoints). When the robot finishes a cycle within this time, the firmware fires NEED_CHARGE and navigates to the dock — even if the battery is fine. Set to -1 to disable this trigger entirely.',
        (v) => { this.patrolConfig.patrolTime = v; },
        { allowMinusOne: true },
      ));
      this.patrolPanel.appendChild(mkLimitRow(
        'Total mission time (s)', -1, 'patrol/set_total_time_limit',
        'Total seconds the patrol may run before auto-stopping. -1 = unlimited.',
        (v) => { this.patrolConfig.totalMissionTime = v; },
        { allowMinusOne: true },
      ));
      this.patrolPanel.appendChild(mkLimitRow(
        'Charge cycle time (s)', -1, 'patrol/set_charge_time_limit',
        'Maximum seconds the robot is allowed to sit on the charging dock before resuming patrol. -1 = unlimited; 0 = do not auto-charge during patrol.',
        (v) => { this.patrolConfig.chargeCycleTime = v; },
        { min: -1, allowMinusOne: true },
      ));
      this.patrolPanel.appendChild(mkLimitRow(
        'Loop count', -1, 'patrol/set_patrol_number_limit',
        'How many times to repeat the full waypoint loop. -1 = unlimited (run until total-time-limit or Stop).',
        (v) => { this.patrolConfig.loopCount = v; },
        { allowMinusOne: true },
      ));
      this.patrolPanel.appendChild(mkTwoLimitRow(
        'Battery SOC range (%)', 10, 80,
        'patrol/set_bms_soc_limit',
        'Battery state-of-charge thresholds. Patrol pauses + heads to dock when SOC drops below MIN; resumes after recharging up to MAX. Firmware defaults: 10 / 80.',
        (a, b) => { this.patrolConfig.bmsSocMin = a; this.patrolConfig.bmsSocMax = b; },
        { min: 0, max: 100 },
      ));

      const clearCfgBtn = this.btn('Reset Patrol Config', 'mapping-btn-warn', () => {
        this.sendCmd('patrol/clear_user_config');
        this.addLog('Patrol user config cleared (limits reset to defaults)');
      });
      clearCfgBtn.title = 'Reset all patrol-side limits (time / loop / SOC) to firmware defaults.';
      this.patrolPanel.appendChild(clearCfgBtn);

      this.navControlsEl.appendChild(this.patrolPanel);

      body.appendChild(this.navControlsEl);
    });
    sidebar.appendChild(this.navSection);

    // ── Autocharge ──
    this.autochargeSection = this.buildSection('Autocharge', (body) => {
      const ctrlRow = document.createElement('div');
      ctrlRow.className = 'mapping-btn-row';
      ctrlRow.appendChild(this.btn('Go to Charging Station', '', () => this.startAutoCharge()));
      ctrlRow.appendChild(this.btn('Cancel Charge', 'mapping-btn-stop', () => this.cancelAutoCharge()));
      body.appendChild(ctrlRow);

      // Plate distance setting (default 0.47 m on the firmware)
      const plateLabelLine = document.createElement('div');
      plateLabelLine.className = 'mapping-cmd-labelline';
      const plateLbl = document.createElement('label');
      plateLbl.className = 'mapping-cmd-label';
      plateLbl.textContent = 'Plate distance (m)';
      plateLabelLine.appendChild(plateLbl);
      plateLabelLine.appendChild(this.mkInfoBtn(
        'Detection-distance threshold for the dock plate (default 0.47 m). The autocharge module only attempts plate detection when within this distance of the dock pose. Increase for more tolerant initial alignment, decrease for stricter behaviour.',
      ));
      body.appendChild(plateLabelLine);

      const plateRow = document.createElement('div');
      plateRow.className = 'mapping-btn-row';
      const plateInput = document.createElement('input');
      plateInput.className = 'mapping-input';
      plateInput.type = 'number';
      plateInput.step = '0.01';
      plateInput.min = '0.1';
      plateInput.max = '2';
      plateInput.placeholder = '0.47';
      plateInput.value = '0.47';
      plateRow.appendChild(plateInput);
      const plateApply = this.btn('Apply', '', () => {
        const v = parseFloat(plateInput.value);
        if (!Number.isFinite(v) || v < 0.1 || v > 2) {
          this.addLog('Plate distance: enter a value between 0.1 and 2 m');
          return;
        }
        this.sendCmd(`autocharge/set_plate_distance/${v.toFixed(2)}`);
      });
      plateApply.style.width = 'auto';
      plateApply.style.minWidth = '64px';
      plateRow.appendChild(plateApply);
      body.appendChild(plateRow);

      // Status query (matches the APK's status-query pattern even though
      // the APK frontend itself doesn't poll it — useful for debugging).
      const statusBtn = this.btn('Get Status', '', async () => {
        const status = await this.queryAutoChargeStatus();
        this.addLog(`Autocharge status: ${status === '1' ? 'active' : status === '0' ? 'inactive' : 'no response'}`);
      });
      body.appendChild(statusBtn);

      // One-click: disable auto-charge during patrol. The patrol module
      // monitors BMS SOC against the configured min/max; setting min=0 and
      // max=100 ensures it never enters NEED_CHARGE. We also force the
      // charge_time_limit to 0 (no time allotted for charging cycles) and
      // abort any in-progress autocharge sequence.
      const disableLabelLine = document.createElement('div');
      disableLabelLine.className = 'mapping-cmd-labelline';
      const disableLbl = document.createElement('label');
      disableLbl.className = 'mapping-cmd-label';
      disableLbl.textContent = 'Disable during patrol';
      disableLabelLine.appendChild(disableLbl);
      disableLabelLine.appendChild(this.mkInfoBtn(
        'Stops the patrol module from auto-docking when battery is low. Sends bms_soc_limit/0/100 + charge_time_limit/0 + autocharge/stop. Reset Patrol Config in the Patrol panel restores firmware defaults.',
      ));
      body.appendChild(disableLabelLine);
      const disableBtn = this.btn('Disable Auto-Charge in Patrol', 'mapping-btn-warn', () => {
        // Persist so the next executePatrol re-sends these (live set fails
        // when the patrol module is idle). Three triggers can fire NEED_CHARGE:
        //   1. BMS SOC < bms_soc_limit_min  → set 1/99 (binary rejects 0/100
        //                                     as out-of-range; 1/99 still
        //                                     effectively never trips)
        //   2. patrol cycle time reached    → set patrol_time_limit=-1
        //   3. charge cycle time reached    → set charge_time_limit=0
        this.patrolConfig.bmsSocMin = 1;
        this.patrolConfig.bmsSocMax = 99;
        this.patrolConfig.patrolTime = -1;
        this.patrolConfig.chargeCycleTime = 0;
        this.sendCmd('patrol/set_bms_soc_limit/1/99');
        this.sendCmd('patrol/set_patrol_time_limit/-1');
        this.sendCmd('patrol/set_charge_time_limit/0');
        this.sendCmd('autocharge/stop');
        this.autoChargeOnReach = false;
        this.autoChargeRetries = 0;
        this.addLog('Auto-charge disabled — saved (will be re-applied on Execute Patrol)');
      });
      body.appendChild(disableBtn);
    });
    sidebar.appendChild(this.autochargeSection);

    // Send Command + Server Log live in the LEFT sidebar — see buildLeftSidebar.
  }

  private buildLeftSidebar(sidebar: HTMLElement): void {
    // ── Send Command (template picker + editable command line) ──
    sidebar.appendChild(this.buildSection('Send Command', (body) => {
      const tplLabel = document.createElement('label');
      tplLabel.className = 'mapping-cmd-label';
      tplLabel.textContent = 'Template';
      body.appendChild(tplLabel);

      const tplSelect = document.createElement('select');
      tplSelect.className = 'mapping-input mapping-cmd-select';
      // value encodes "<topic>|<command>" so we know which DDS topic to publish on
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— pick a template —';
      tplSelect.appendChild(placeholder);
      for (const group of COMMAND_TEMPLATES) {
        const og = document.createElement('optgroup');
        og.label = group.label;
        for (const tpl of group.items) {
          const opt = document.createElement('option');
          opt.value = `${tpl.topic}|${tpl.cmd}`;
          opt.textContent = tpl.cmd;
          og.appendChild(opt);
        }
        tplSelect.appendChild(og);
      }
      body.appendChild(tplSelect);

      const cmdLabel = document.createElement('label');
      cmdLabel.className = 'mapping-cmd-label';
      cmdLabel.textContent = 'Command (editable)';
      body.appendChild(cmdLabel);

      const cmdInput = document.createElement('textarea');
      cmdInput.className = 'mapping-input mapping-cmd-payload';
      cmdInput.placeholder = 'mapping/start';
      cmdInput.rows = 2;
      body.appendChild(cmdInput);

      let currentTopic: string = RTC_TOPIC.USLAM_CMD;
      const topicHint = document.createElement('div');
      topicHint.className = 'mapping-cmd-hint';
      topicHint.textContent = `→ ${currentTopic}`;
      body.appendChild(topicHint);

      tplSelect.addEventListener('change', () => {
        if (!tplSelect.value) return;
        const [topic, cmd] = tplSelect.value.split('|');
        currentTopic = topic;
        cmdInput.value = cmd;
        topicHint.textContent = `→ ${topic}`;
      });

      const sendBtn = this.btn('Send', 'mapping-btn-start', () => {
        const raw = cmdInput.value;
        if (!raw.trim()) { this.addLog('Send: command is empty'); return; }
        let payload: unknown = raw;
        const trimmed = raw.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try { payload = JSON.parse(trimmed); }
          catch (e) { this.addLog(`Send: invalid JSON — ${(e as Error).message}`); return; }
        }
        this.publish(currentTopic, payload);
        const preview = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.addLog(`> ${currentTopic}: ${preview.slice(0, 120)}`);
        console.log('[slam] Manual send:', currentTopic, payload);
      });
      body.appendChild(sendBtn);
    }));

    // ── Server Log ──
    sidebar.appendChild(this.buildSection('Server Log', (body) => {
      const header = document.createElement('div');
      header.className = 'mapping-log-header';
      const topicHint = document.createElement('div');
      topicHint.className = 'mapping-cmd-hint mapping-log-topic';
      topicHint.textContent = `← ${RTC_TOPIC.USLAM_SERVER_LOG}`;
      header.appendChild(topicHint);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'mapping-log-copy';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        const text = this.logEl?.innerText ?? '';
        try {
          await navigator.clipboard.writeText(text);
          const prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = prev; }, 1200);
        } catch {
          copyBtn.textContent = 'Failed';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        }
      });
      header.appendChild(copyBtn);
      body.appendChild(header);

      this.logEl = document.createElement('div');
      this.logEl.className = 'mapping-log';
      body.appendChild(this.logEl);
    }));
  }

  private buildSection(title: string, buildBody: (body: HTMLElement) => void): HTMLElement {
    const section = document.createElement('div');
    section.className = 'mapping-section';
    const heading = document.createElement('div');
    heading.className = 'mapping-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'mapping-section-body';
    buildBody(body);
    section.appendChild(body);
    return section;
  }

  private btn(label: string, extraClass: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `mapping-btn ${extraClass}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Small "i" badge with a hover tooltip + click toggle for touch users.
   * Uses the native title attribute so it also works for screen readers.
   */
  private mkInfoBtn(text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'mapping-info-btn';
    b.type = 'button';
    b.textContent = 'i';
    b.title = text;
    b.setAttribute('aria-label', text);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      this.showNotification(text, '#6879e4');
    });
    return b;
  }

  private clickModeBtn(label: string, mode: ClickMode): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'mapping-btn mapping-btn-click-mode';
    b.textContent = label;
    b.addEventListener('click', () => {
      if (this.activeClickBtn === b) {
        // Deactivate
        b.classList.remove('active');
        this.activeClickBtn = null;
        this.slamScene?.setClickMode('none');
      } else {
        // Deactivate previous
        if (this.activeClickBtn) this.activeClickBtn.classList.remove('active');
        // Activate
        b.classList.add('active');
        this.activeClickBtn = b;
        this.slamScene?.setClickMode(mode);
      }
    });
    return b;
  }

  // ── Commands ──

  private sendCmd(cmd: string): void {
    console.log(`[slam] Sending: ${cmd}`);
    this.publish(RTC_TOPIC.USLAM_CMD, cmd);
  }

  /** Unified handler for all click+drag pose sets (initial_pose, goal, patrol) */
  private handlePoseSet(mode: ClickMode, x: number, y: number, yaw: number): void {
    const yawDeg = (yaw * 180 / Math.PI).toFixed(1);

    switch (mode) {
      case 'initial_pose':
        this.sendCmd(`localization/set_initial_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.addLog(`Initial pose: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${yawDeg}`);
        // Deactivate click mode button
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        // Auto-start localization after setting pose
        this.localizingInProgress = true;
        this.locStartBtn.style.display = 'none';
        this.locAbortBtn.style.display = '';
        this.setLocStatus('Localizing...', '#6879e4');
        setTimeout(() => {
          this.sendCmd('localization/start');
        }, 100);
        break;

      case 'goal':
        console.log(`[slam] Goal pose: x=${x.toFixed(3)} y=${y.toFixed(3)} yaw=${yaw.toFixed(3)} (${yawDeg}°)`);
        this.sendCmd(`navigation/set_goal_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.slamScene?.setGoalMarker(x, y, yaw);
        this.addLog(`Goal set: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${yawDeg}`);
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        break;

      case 'patrol':
        console.log(`[slam] Patrol waypoint ${this.patrolCount + 1}: x=${x.toFixed(3)} y=${y.toFixed(3)} yaw=${yaw.toFixed(3)} (${yawDeg}°)`);
        this.patrolPoints.push({ x, y, yaw });
        this.slamScene?.addPatrolMarker(x, y, yaw, this.patrolCount);
        this.patrolCount++;
        this.addLog(`Waypoint ${this.patrolCount}: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${yawDeg}`);
        // Auto-deactivate after placing (same as Set Goal)
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        break;
    }
  }

  // ── Patrol Execution (matches APK flow) ──

  private async executePatrol(): Promise<void> {
    const n = this.patrolPoints.length;
    if (n < 2) {
      const msg = `Need at least 2 waypoints to start patrol (have ${n})`;
      this.addLog(msg);
      this.showNotification(msg, '#FCD335');
      return;
    }

    this.addLog(`Executing patrol with ${n} waypoints...`);

    // APK ordering (handleSureExecutePatrol):
    //   1. patrol/start  — puts the module in a state that accepts config
    //                      commands. Without this, after a previous stop the
    //                      module rejects clear/add/set_*_limit.
    //   2. 500ms breather (matches the APK's `await setTimeout(500)`).
    //   3. clear_all_patrol_points
    //   4. add_patrol_point × N
    //   5. set_*_time_limit × 3
    //   6. patrol/go (begin actual patrolling)

    this.sendCmd('patrol/start');
    await this.delay(500);

    this.sendCmd('patrol/clear_all_patrol_points');
    await this.delay(200);

    for (const pt of this.patrolPoints) {
      this.sendCmd(`patrol/add_patrol_point/${pt.x.toFixed(3)}/${pt.y.toFixed(3)}/${pt.yaw.toFixed(3)}`);
      await this.delay(100);
    }

    // Apply stored patrol config — these only succeed during INITIALIZE,
    // which is why the standalone Apply buttons fail when patrol is idle.
    const c = this.patrolConfig;
    this.sendCmd(`patrol/set_total_time_limit/${c.totalMissionTime}`);
    await this.delay(50);
    this.sendCmd(`patrol/set_patrol_time_limit/${c.patrolTime}`);
    await this.delay(50);
    this.sendCmd(`patrol/set_charge_time_limit/${c.chargeCycleTime}`);
    await this.delay(50);
    this.sendCmd(`patrol/set_patrol_number_limit/${c.loopCount}`);
    await this.delay(50);
    this.sendCmd(`patrol/set_bms_soc_limit/${c.bmsSocMin}/${c.bmsSocMax}`);
    await this.delay(200);

    this.sendCmd('patrol/go');
    this.setState('patrolling');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Auto-charge ──
  // APK flow (`bA`): navigation/start, then 1s later set_goal_pose to dock
  // [-0.15, 0]. On REACHED, our handler fires autocharge/start. On
  // autocharge/state_transition/FAILURE we retry up to 5 times.
  private async startAutoCharge(): Promise<void> {
    this.autoChargeRetries = 0;
    this.autoChargeOnReach = true;
    if (!this.navigationActive) {
      this.sendCmd('navigation/start');
      this.navigationActive = true;
      this.setState('navigating');
      this.updateNavControls();
      await this.delay(1000);
    }
    this.sendCmd('navigation/set_goal_pose/-0.150/0.000/0.000');
    this.addLog('Navigating to charging station...');
  }

  private cancelAutoCharge(): void {
    this.autoChargeOnReach = false;
    this.autoChargeRetries = 0;
    // Mirrors APK's `_A`: stop nav and the autocharge module both.
    this.sendCmd('navigation/stop');
    this.sendCmd('autocharge/stop');
    this.slamScene?.clearNavPath();
    this.slamScene?.clearGoalMarker();
    this.navigationActive = false;
    this.updateNavControls();
    this.setState('localized');
    this.addLog('Auto-charge cancelled');
  }

  // ── Flow Gating ──

  private updateFlowGating(): void {
    // Localization: requires map
    const canLocalize = this.mapLoaded;
    this.locSection.classList.toggle('mapping-section-disabled', !canLocalize);
    this.locHint.style.display = canLocalize ? 'none' : '';

    // Navigation & Patrol: requires localized
    const canNavigate = this.mapLoaded && this.localized;
    this.navSection.classList.toggle('mapping-section-disabled', !canNavigate);
    this.navHint.style.display = canNavigate ? 'none' : '';
    // Autocharge piggybacks on the same navigation requirements.
    this.autochargeSection?.classList.toggle('mapping-section-disabled', !canNavigate);

    // Reset nav controls when losing localization
    if (!canNavigate) {
      this.navigationActive = false;
      this.updateNavControls();
    }

    // Stepper depends on mapLoaded/localized — refresh whenever gating changes.
    this.updateStateDisplay();
  }

  private updateNavControls(): void {
    this.navStartBtn.style.display = this.navigationActive ? 'none' : '';
    this.navStopBtn.style.display = this.navigationActive ? '' : 'none';
    this.navControlsEl.classList.toggle('mapping-section-disabled', !this.navigationActive);
  }

  private setNavMode(mode: 'goal' | 'patrol'): void {
    const prev = this.navMode;
    this.navMode = mode;

    // Deactivate any active click mode when switching
    if (this.activeClickBtn) {
      this.activeClickBtn.classList.remove('active');
      this.activeClickBtn = null;
      this.slamScene?.setClickMode('none');
    }

    // Cleanup when leaving patrol (matching APK: pause + stop + clear visuals)
    if (prev === 'patrol' && mode === 'goal') {
      this.sendCmd('patrol/pause');
      this.sendCmd('patrol/stop');
      this.slamScene?.clearPatrolMarkers();
      this.slamScene?.clearTrace();
      this.patrolPaused = false;
      this.addLog('Patrol stopped — switched to Go to Goal');
    }

    // Cleanup when leaving goal
    if (prev === 'goal' && mode === 'patrol') {
      this.slamScene?.clearGoalMarker();
      this.slamScene?.clearNavPath();
    }

    // Toggle panels
    this.goalPanel.style.display = mode === 'goal' ? '' : 'none';
    this.patrolPanel.style.display = mode === 'patrol' ? '' : 'none';
    // Toggle tab styling
    this.goalModeBtn.classList.toggle('active', mode === 'goal');
    this.patrolModeBtn.classList.toggle('active', mode === 'patrol');

    // The stepper's Navigation label reflects the current mode.
    this.updateStateDisplay();
  }

  private setLocStatus(msg: string, color: string): void {
    if (!msg) {
      this.locStatusEl.style.display = 'none';
      return;
    }
    this.locStatusEl.style.display = '';
    this.locStatusEl.textContent = msg;
    this.locStatusEl.style.color = color;
  }

  /** Push battery percent to the header widget (called from app.ts on LOW_STATE). */
  setBattery(percent: number): void {
    if (!this.batteryFill || !this.batteryText) return;
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    this.batteryText.textContent = `${p}%`;
    this.batteryFill.style.width = `${p}%`;
    // Same colour coding as the NavBar: red <=33%, yellow 34–66%, green 67%+
    const color = p <= 33 ? '#FF3D3D' : p <= 66 ? '#FCD335' : '#42CF55';
    this.batteryFill.style.backgroundColor = color;
  }

  /** Set the connection-type label (STA-L / STA-T / AP / etc.) — matches NavBar. */
  setNetworkType(type: string): void {
    if (!this.netTypeEl) return;
    this.netTypeEl.textContent = type;
    // Match NavBar: swap the WiFi icon based on the actual transport.
    let src = '/sprites/icon_wifi.png';
    const upper = type.toUpperCase();
    if (upper === '4G' || upper === 'LTE') src = '/sprites/icon_net_4g.png';
    else if (upper === 'AP') src = '/sprites/icon_net_ap.png';
    else if (upper === 'STA-T' || upper === 'REMOTE') src = '/sprites/icon_net_remote.png';
    else if (upper === 'STA-L') src = '/sprites/icon_net_sta.png';
    if (this.wifiIconEl && this.wifiIconEl.getAttribute('src') !== src) {
      this.wifiIconEl.src = src;
    }
  }

  /** Set the max motor temperature label — matches NavBar's color thresholds. */
  setMotorTemp(maxTemp: number): void {
    if (!this.motorTempEl) return;
    const t = Math.round(maxTemp);
    this.motorTempEl.textContent = `${t}°C`;
    if (t > 70) this.motorTempEl.style.color = '#FF3D3D';
    else if (t > 50) this.motorTempEl.style.color = '#FCD335';
    else this.motorTempEl.style.color = '#aaa';
  }

  /** Push the live video stream into the PiP overlay. */
  setStream(stream: MediaStream): void {
    this.pipCamera?.setStream(stream);
  }

  /** Forward BT status to the inline icon, mirroring the body-mounted one. */
  setBtStatus(s: BluetoothStatus): void {
    if (!this.btIconWrap) return;
    const connected = s.robotConnected || s.remoteConnected;
    const color = s.remoteConnected ? '#4FC3F7' : s.robotConnected ? '#42CF55' : '#b0b3bb';
    this.btIconWrap.innerHTML = BT_SVG(color);
    this.btIconWrap.dataset.connected = connected ? 'true' : 'false';
    const label = s.remoteName || s.remoteAddress || s.robotAddress || 'not connected';
    this.btIconWrap.title = `Bluetooth: ${label}`;
  }

  private showNotification(msg: string, color: string): void {
    const el = document.createElement('div');
    el.className = 'mapping-notification';
    el.textContent = msg;
    el.style.borderLeftColor = color;
    this.container.appendChild(el);
    setTimeout(() => el.classList.add('mapping-notification-show'), 10);
    setTimeout(() => {
      el.classList.remove('mapping-notification-show');
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // ── State ──

  // Human-readable labels for state machine transitions
  private static readonly STATE_LABELS: Record<string, string> = {
    // Navigation
    'IDLE': 'Idle',
    'NAVIGATE_TO_GOAL_POINT': 'Navigating to goal...',
    'GOAL_POINT_REACHED': 'Goal reached',
    'GOAL_POINT_UNREACHABLE': 'Goal unreachable',
    'GOAL_OCCUPIED': 'Goal occupied',
    'GOAL_CANCELLED': 'Goal cancelled',
    'GOAL_CHANGED': 'Goal changed',
    'TRACKING': 'Tracking path...',
    'WAITING': 'Waiting...',
    'FAILURE': 'Navigation failed',
    // Patrol
    'SELECT_GOAL_POINT': 'Selecting next waypoint...',
    'NAVIGATE_TO_CHARGE_BOARD': 'Going to charger...',
    'NAVIGATE_TO_CHARGE_BOARD_FAILED': 'Failed to reach charger',
    'IS_CHARGING': 'Charging...',
    'NO_GOAL_POINT_TO_SELECT': 'No waypoints available',
    'REACH_PATROL_NUMBER_LIMIT': 'Patrol cycle limit reached',
    'REACH_PATROL_TIME_LIMIT': 'Patrol time limit reached',
    'REACH_TOTAL_TIME_LIMIT': 'Total time limit reached',
    'FINISHED': 'Patrol complete',
    'STAND_UP': 'Standing up...',
    // AutoCharge
    'SUCCESS': 'Auto-charge complete',
    // Timeouts
    'TIMEOUT_LOCALIZATION': 'Localization timeout',
    'TIMEOUT_NAVIGATION': 'Navigation timeout',
    'TIMEOUT_ODOMETRY': 'Odometry timeout',
    'TIMEOUT_POINTCLOUD': 'Point cloud timeout',
    'TIMEOUT_CONNECT_POWER': 'Power connection timeout',
    'TIMEOUT_DETECT': 'Detection timeout',
    'TIMEOUT_RUNNING': 'Running timeout',
    'TIMEOUT_TRY_CHARGE': 'Charge attempt timeout',
    // Control
    'STAND_DOWN': 'Crouching down...',
  };

  private setState(s: SlamState): void {
    this.state = s;
    this.updateStateDisplay();
    // Clear sub-state when changing main state
    if (s === 'idle' || s === 'localized') {
      this.setSubState('');
    }
  }

  private updateStateDisplay(): void {
    if (!this.stateEl) return;

    // Per-step status: 'active' (current), 'done' (already passed),
    // 'idle' (not yet reached). Drives both colour and the connector arrow.
    type StepStatus = 'idle' | 'done' | 'active';

    const mapping: StepStatus = this.state === 'mapping' ? 'active'
      : this.mapLoaded ? 'done' : 'idle';

    const localization: StepStatus = this.state === 'localized' ? 'active'
      : this.localized ? 'done' : 'idle';

    // Navigation step is "active" whenever the robot's nav module is running:
    // navigationActive (goal mode) or state === 'patrolling'. Sub-states like
    // WAITING after REACHED don't change this — the user can still dispatch
    // another goal or press Stop without re-pressing Start.
    const navLabel = 'Navigation';
    let navStatus: StepStatus = 'idle';
    if (this.state === 'patrolling' || this.navigationActive) {
      navStatus = 'active';
    }

    // Localization is "done" when nav is running on top of it (we've moved on).
    const navRunning = navStatus === 'active';
    const localizationFinal: StepStatus = navRunning ? 'done' : localization;

    const steps: Array<{ key: string; label: string; status: StepStatus }> = [
      { key: 'mapping',      label: 'Step 1: Mapping',      status: mapping },
      { key: 'localization', label: 'Step 2: Localization', status: localizationFinal },
      { key: 'navigation',   label: `Step 3: ${navLabel}`,  status: navStatus },
    ];

    // Uniform colour scheme across steps: green = passed, yellow = current,
    // grey = not reached. Keeps the eye trained on a single colour for state.
    const COLOR = { done: '#42CF55', active: '#FCD335', idle: '#3a3d45' } as const;

    this.stateEl.innerHTML = '';
    steps.forEach((step, i) => {
      if (i > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'mapping-stepper-arrow';
        arrow.textContent = '➜';
        this.stateEl.appendChild(arrow);
      }
      const cell = document.createElement('div');
      cell.className = `mapping-stepper-step mapping-stepper-${step.status}`;
      const dot = document.createElement('span');
      dot.className = 'mapping-stepper-dot';
      const color = COLOR[step.status];
      dot.style.background = color;
      if (step.status === 'active') dot.style.boxShadow = `0 0 6px ${color}`;
      cell.appendChild(dot);
      const lbl = document.createElement('span');
      lbl.className = 'mapping-stepper-label';
      lbl.textContent = step.label;
      if (step.status === 'active') lbl.style.color = color;
      else if (step.status === 'done') lbl.style.color = color;
      cell.appendChild(lbl);
      this.stateEl.appendChild(cell);
    });
  }

  private setSubState(detail: string, color?: string): void {
    if (!this.subStateEl) return;
    if (!detail) {
      this.subStateEl.style.display = 'none';
      return;
    }
    this.subStateEl.style.display = '';
    this.subStateEl.textContent = detail;
    this.subStateEl.style.color = color ?? '#888';
  }

  // ── State Transition Parsing ──

  private parseStateTransitions(msg: string): void {
    // navigation/state_transition/{STATE}
    const navMatch = msg.match(/navigation\/state_transition\/(\w+)/);
    if (navMatch) {
      const raw = navMatch[1];
      const label = MappingPage.STATE_LABELS[raw] ?? raw.replace(/_/g, ' ').toLowerCase();
      const isError = raw.includes('UNREACHABLE') || raw.includes('FAILURE') || raw.includes('TIMEOUT');
      this.setSubState(`Nav: ${label}`, isError ? '#FF3D3D' : '#FCD335');
    }

    // patrol/state_transition/{STATE}
    const patrolMatch = msg.match(/patrol\/state_transition\/(\w+)/);
    if (patrolMatch) {
      const raw = patrolMatch[1];
      const label = MappingPage.STATE_LABELS[raw] ?? raw.replace(/_/g, ' ').toLowerCase();
      const isError = raw.includes('FAILED') || raw.includes('UNREACHABLE') || raw.includes('TIMEOUT') || raw.includes('NO_GOAL');
      const isLimit = raw.includes('LIMIT') || raw === 'FINISHED';
      this.setSubState(`Patrol: ${label}`, isError ? '#FF3D3D' : isLimit ? '#6879e4' : '#66E7BE');
    }

    // patrol/new_goal_point/{x}/{y}/{yaw}
    const goalPtMatch = msg.match(/patrol\/new_goal_point\/([\d.-]+)\/([\d.-]+)\/([\d.-]+)/);
    if (goalPtMatch) {
      this.setSubState(`Patrol target: (${parseFloat(goalPtMatch[1]).toFixed(2)}, ${parseFloat(goalPtMatch[2]).toFixed(2)})`, '#66E7BE');
    }

    // autocharge/state_transition/{STATE}
    const chargeMatch = msg.match(/autocharge\/state_transition\/(\w+)/);
    if (chargeMatch) {
      const raw = chargeMatch[1];
      const label = MappingPage.STATE_LABELS[raw] ?? raw.replace(/_/g, ' ').toLowerCase();
      this.setSubState(`Charge: ${label}`, raw === 'SUCCESS' ? '#42CF55' : '#FF3D3D');
    }

    // control/recv_cmd/{CMD}
    const ctrlMatch = msg.match(/control\/recv_cmd\/(\w+)/);
    if (ctrlMatch) {
      const raw = ctrlMatch[1];
      const label = MappingPage.STATE_LABELS[raw] ?? raw.replace(/_/g, ' ').toLowerCase();
      this.setSubState(`Control: ${label}`, '#888');
    }
  }

  // ── Status Queries (Promise-based, matching APK pattern) ──
  // The robot replies on the server-log topic with `<module>/get_status/status/<code>`.
  // Codes: "1" = active, "0" = inactive, "-1" = our 2s timeout fallback.

  private locStatusResolver: ((status: string) => void) | null = null;
  private navStatusResolver: ((status: string) => void) | null = null;
  private patrolStatusResolver: ((status: string) => void) | null = null;
  private mappingStatusResolver: ((status: string) => void) | null = null;
  private autoChargeStatusResolver: ((status: string) => void) | null = null;
  private mapIdResolver: ((id: string) => void) | null = null;

  queryAutoChargeStatus(): Promise<string> {
    return new Promise((resolve) => {
      this.autoChargeStatusResolver = resolve;
      window.setTimeout(() => {
        if (this.autoChargeStatusResolver === resolve) {
          this.autoChargeStatusResolver = null;
          resolve('-1');
        }
      }, 2000);
      this.sendCmd('autocharge/get_status');
    });
  }

  /**
   * Ask the robot for its currently-active map id. Resolves with the id or
   * the empty string on timeout. Listener lives in handleServerLog (it parses
   * `common/get_map_id/map_id/<id>` and resolves this promise).
   */
  queryCurrentMapId(): Promise<string> {
    return new Promise((resolve) => {
      this.mapIdResolver = resolve;
      window.setTimeout(() => {
        if (this.mapIdResolver === resolve) {
          this.mapIdResolver = null;
          resolve('');
        }
      }, 2000);
      this.sendCmd('common/get_map_id');
    });
  }

  queryLocalizationStatus(): Promise<string> {
    return new Promise((resolve) => {
      this.locStatusResolver = resolve;
      window.setTimeout(() => {
        if (this.locStatusResolver === resolve) {
          this.locStatusResolver = null;
          resolve('-1');
        }
      }, 2000);
      this.sendCmd('localization/get_status');
    });
  }

  queryMappingStatus(): Promise<string> {
    return new Promise((resolve) => {
      this.mappingStatusResolver = resolve;
      window.setTimeout(() => {
        if (this.mappingStatusResolver === resolve) {
          this.mappingStatusResolver = null;
          resolve('-1');
        }
      }, 2000);
      this.sendCmd('mapping/get_status');
    });
  }

  queryNavigationStatus(): Promise<string> {
    return new Promise((resolve) => {
      this.navStatusResolver = resolve;
      window.setTimeout(() => {
        if (this.navStatusResolver === resolve) {
          this.navStatusResolver = null;
          resolve('-1');
        }
      }, 2000);
      this.sendCmd('navigation/get_status');
    });
  }

  queryPatrolStatus(): Promise<string> {
    return new Promise((resolve) => {
      this.patrolStatusResolver = resolve;
      window.setTimeout(() => {
        if (this.patrolStatusResolver === resolve) {
          this.patrolStatusResolver = null;
          resolve('-1');
        }
      }, 2000);
      this.sendCmd('patrol/get_status');
    });
  }

  /** Request patrol points from robot. Response arrives as server log messages. */
  requestPatrolPoints(): void {
    this.sendCmd('patrol/get_patrol_points');
  }

  /**
   * Probe the robot's current state on entry and restore UI accordingly.
   * Each queryX uses its own resolver field, so they're safe to run in parallel.
   *
   * Precedence: mapping > localization (with optional patrol/navigation). If a
   * mapping session is in progress we show the mapping UI; otherwise if
   * localized, unlock localization/navigation; if also patrolling/navigating,
   * restore that mode.
   */
  private async preloadRobotState(): Promise<void> {
    try {
      const [mapping, loc, patrol, nav, autocharge] = await Promise.all([
        this.queryMappingStatus(),
        this.queryLocalizationStatus(),
        this.queryPatrolStatus(),
        this.queryNavigationStatus(),
        this.queryAutoChargeStatus(),
      ]);
      if (autocharge === '1') this.addLog('Preload: autocharge already running');
      this.addLog(`Preload: mapping=${mapping} loc=${loc} patrol=${patrol} nav=${nav} autocharge=${autocharge}`);

      if (mapping === '1') {
        // A mapping session is already in progress.
        this.setState('mapping');
        this.updateFlowGating();
        return;
      }

      if (loc === '1') {
        // Robot is localized → a map must be loaded on the slot. Unlock both
        // Localization and Navigation sections by reflecting that in our
        // gating state (mapLoaded is required by updateFlowGating).
        this.mapLoaded = true;
        this.localized = true;
        this.slamScene?.showRobot(true);
        for (const topic of LOC_USLAM_TOPICS) this.subscribe(topic);

        if (patrol === '1') {
          this.setState('patrolling');
          this.requestPatrolPoints();
          this.setNavMode('patrol');
        } else if (nav === '1') {
          this.navigationActive = true;
          this.setState('navigating');
          // Reflect the running-nav UI: hide Start, show Stop.
          this.updateNavControls();
        } else {
          this.setState('localized');
        }

        // Reflect the active-localization UI: hide Start, show Stop.
        this.locStartBtn.style.display = 'none';
        this.locAbortBtn.style.display = '';
        this.locAbortBtn.textContent = 'Stop Localization';
        this.setLocStatus('Localized', '#42CF55');

        this.updateFlowGating();

        // Pull the active map id from the robot and render its cached PCD so
        // the user sees the same map the robot is operating on.
        void this.preloadActiveMap();
        return;
      }

      // Not localized but a map could still be loaded (e.g. user only set the
      // map id). We don't have a direct "is map loaded" query, so leave gating
      // as-is and let the user proceed manually.
    } catch (err) {
      this.addLog(`Preload failed: ${err}`);
    }
  }

  /**
   * Fetch the robot's active map id and render its cached PCD in the viewer.
   * Falls back to fetching the robot's current slot if there's no local cache
   * for that id (without writing the result to cache, since we can't be sure
   * the slot data really corresponds to that id — the robot relabels freely).
   */
  private async preloadActiveMap(): Promise<void> {
    const id = await this.queryCurrentMapId();
    if (!id) {
      this.addLog('Preload: no active map id from robot');
      return;
    }
    this.addLog(`Preload: active map id ${id}`);
    // Mark the slot as holding this id — we KNOW it does because the robot
    // just told us. This also lets a future Load on the same id skip uploading.
    this.robotSlotMapId = id;
    let bundle: MapBundle | null;
    try { bundle = await getBundle(id); }
    catch (err) { this.addLog(`Preload: cache lookup failed: ${err}`); return; }
    if (bundle?.pcd) {
      this.slamScene?.clearLoadedPcd();
      this.slamScene?.loadPCD(bundle.pcd);
      this.addLog(`Preload: rendered cached PCD (${(bundle.pcd.byteLength / 1024).toFixed(1)} KB)`);
      return;
    }
    // No cache — fetch from robot's slot for visualization only.
    if (!this.requestFile) return;
    this.addLog('Preload: no cache for this id; fetching slot for view');
    const pcd = await this.fetchRobotFile('map.pcd');
    if (pcd) {
      this.slamScene?.clearLoadedPcd();
      this.slamScene?.loadPCD(pcd);
      this.addLog(`Preload: rendered robot's slot PCD (${(pcd.byteLength / 1024).toFixed(1)} KB) — NOT cached`);
    }
  }

  // ── Log ──

  private addLog(msg: string): void {
    if (!this.logEl) return;
    const line = document.createElement('div');
    line.className = 'mapping-log-line';
    line.textContent = `> ${msg}`;
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    // Keep max 50 lines
    while (this.logEl.children.length > 50) {
      this.logEl.removeChild(this.logEl.firstChild!);
    }
  }

  // ── Topic Message Handling ──

  /** Forward motor state to Go2 model for joint sync */
  updateMotorState(motors: Array<{ q: number }>): void {
    this.slamScene?.updateMotorState(motors);
  }

  private topicLogCount = 0;

  handleTopicMessage(topic: string, data: unknown): void {
    if (this.topicLogCount < 30) {
      console.log('[slam] Topic:', topic, 'data type:', typeof data, data instanceof ArrayBuffer ? `AB(${data.byteLength})` : '');
      this.topicLogCount++;
    }
    switch (topic) {
      case RTC_TOPIC.USLAM_SERVER_LOG:
        this.handleServerLog(data);
        break;
      case RTC_TOPIC.USLAM_CLOUD_WORLD:
        this.handleCloudWorld(data);
        break;
      case RTC_TOPIC.USLAM_ODOM:
        this.handleOdom(data);
        break;
      case RTC_TOPIC.USLAM_LOC_ODOM:
        this.handleOdom(data);
        break;
      case RTC_TOPIC.USLAM_LOC_CLOUD:
        this.handleLocalizationCloud(data);
        break;
      case RTC_TOPIC.USLAM_NAV_PATH:
        this.handleLocalizationCloud(data, 'navigation-path');
        break;
      case RTC_TOPIC.USLAM_CLOUD_MAP:
        this.handleCloudMap(data);
        break;
    }
  }

  private handleServerLog(data: unknown): void {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    this.addLog(msg);
    console.log('[slam] Server log:', msg);

    // ── Map state transitions ──
    if (msg.includes('mapping/stop/success')) {
      this.setState('idle');
      this.mapLoaded = true;
      // Hide live white laser scan once mapping ends (APK behavior)
      this.slamScene?.updateLaserCloud(new Float32Array(0));
      this.updateFlowGating();
    }
    if (msg.includes('mapping/start/success')) this.setState('mapping');

    // Map loaded via set_map_id
    if (msg.includes('common/set_map_id') && msg.includes('success')) {
      this.mapLoaded = true;
      this.updateFlowGating();
      this.showNotification('Map loaded successfully', '#42CF55');
    }

    // ── Localization state transitions (exact message matching) ──
    if (msg.includes('[Localization] initialization succeed!')) {
      this.localizingInProgress = false;
      this.localized = true;
      this.setState('localized');
      this.slamScene?.showRobot(true);

      // Subscribe to localization topics now (matching APK)
      for (const topic of LOC_USLAM_TOPICS) {
        this.subscribe(topic);
      }

      // Update localization UI
      this.locStartBtn.style.display = 'none';
      this.locAbortBtn.style.display = '';
      this.locAbortBtn.textContent = 'Stop Localization';
      this.setLocStatus('Localized', '#42CF55');
      this.showNotification('Localization successful - robot visible on map', '#42CF55');
      this.updateFlowGating();
    }
    if (msg.includes('[Localization] initialization failed!')) {
      this.localizingInProgress = false;
      this.localized = false;
      this.setState('idle');
      // Clear real-time white point cloud
      this.slamScene?.updateLaserCloud(new Float32Array(0));
      // Unsubscribe localization topics
      for (const topic of LOC_USLAM_TOPICS) {
        this.unsubscribe(topic);
      }

      // Update localization UI — highlight Set Initial Pose as next step
      this.locStartBtn.style.display = '';
      this.locAbortBtn.style.display = 'none';
      this.locSetPoseBtn.classList.add('mapping-btn-highlight');
      this.setLocStatus('Auto-localization failed — set initial pose to help the algorithm', '#FF3D3D');
      this.showNotification('Auto-localization failed. Please set the initial pose manually to help the localization algorithm.', '#FF3D3D');
      this.updateFlowGating();
    }

    // ── Navigation state transitions (APK behaviour) ──
    // The nav module stays running through REACHED/NO_PATH/TIMEOUT/etc — the
    // user must press Stop Navigation to actually end it. Only the per-goal
    // viz markers are cleared. Main `state` (and the stepper) continue to
    // reflect navigationActive, not these sub-events.
    // WAITING / TRACKING are informational — no toast or cleanup.
    if (msg.includes('navigation/state_transition/REACHED')) {
      this.slamScene?.clearNavPath();
      this.slamScene?.clearGoalMarker();
      if (this.autoChargeOnReach) {
        // APK flow: after reaching dock, send autocharge/start (firmware handles crouching)
        this.autoChargeOnReach = false;
        this.sendCmd('autocharge/start');
        this.addLog('Reached charging dock — starting auto-charge...');
        this.showNotification('Reached dock — auto-charging...', '#42CF55');
      } else {
        this.showNotification('Navigation goal reached', '#42CF55');
      }
      // Force a stepper redraw — though state is unchanged, the goal marker
      // was cleared, which doesn't auto-trigger updateStateDisplay otherwise.
      this.updateStateDisplay();
    }
    if (msg.includes('navigation/state_transition/NO_PATH')) {
      this.slamScene?.clearNavPath();
      this.showNotification('No path to goal', '#FF3D3D');
    }
    if (msg.includes('navigation/state_transition/TIMEOUT')) {
      this.showNotification('Navigation timed out', '#FF3D3D');
    }
    if (msg.includes('navigation/state_transition/GOAL_OCCUPIED')) {
      this.showNotification('Goal location is occupied', '#FCD335');
    }
    if (msg.includes('navigation/state_transition/GOAL_CHANGED')) {
      this.showNotification('Goal changed', '#FCD335');
    }
    if (msg.includes('navigation/state_transition/FAILURE')) {
      // APK's JA() teardown — clear viz, no toast. Don't drop navigationActive
      // or main state; the user explicitly stops via the Stop button.
      this.slamScene?.clearNavPath();
      this.slamScene?.clearGoalMarker();
    }
    if (msg.includes('navigation/state_transition/GOAL_CANCELLED')) {
      // Robot dropped the current goal (e.g. on receiving a new one) —
      // informational only, the path is about to be replanned.
      this.slamScene?.clearNavPath();
    }
    // Auto-charge success/failure
    // Autocharge sub-state machine (visible to the user, since the flow has
    // multiple steps and silent failures otherwise look like the UI froze).
    if (msg.includes('autocharge/state_transition/GO_TO_CHARGE_BOARD')) {
      this.showNotification('Auto-charge: approaching dock plate…', '#FCD335');
    }
    if (msg.includes('autocharge/state_transition/CONNECTING')) {
      this.showNotification('Auto-charge: connecting to dock contacts…', '#FCD335');
    }
    if (msg.includes('autocharge/state_transition/TIMEOUT_DETECT')) {
      this.showNotification('Auto-charge: dock plate not detected (try autocharge/set_plate_distance)', '#FF3D3D');
    }
    if (msg.includes('autocharge/state_transition/TIMEOUT_CONNECT_POWER')) {
      this.showNotification('Auto-charge: power did not connect (mechanical alignment off)', '#FF3D3D');
    }
    if (msg.includes('autocharge/state_transition/EXIT')) {
      this.addLog('Auto-charge module exited');
    }
    if (msg.includes('autocharge/state_transition/SUCCESS')) {
      this.showNotification('Auto-charge complete', '#42CF55');
      this.autoChargeRetries = 0;
      this.autoChargeOnReach = false;
      this.setState('localized');
    }
    if (msg.includes('autocharge/state_transition/FAILURE')) {
      // The robot's autocharge module gave up — re-driving to the same dock
      // pose rarely fixes it (the cause is plate detection / contact, not
      // navigation), but we mirror the APK's retry-up-to-5x behaviour.
      if (this.autoChargeRetries < MappingPage.AUTO_CHARGE_MAX_RETRIES) {
        this.autoChargeRetries++;
        this.showNotification(`Auto-charge failed — retry ${this.autoChargeRetries}/${MappingPage.AUTO_CHARGE_MAX_RETRIES} (re-approaching dock)`, '#FF3D3D');
        this.sendCmd('navigation/set_goal_pose/-0.150/0.000/0.000');
        this.autoChargeOnReach = true;
      } else {
        this.showNotification('Auto-charge failed after 5 retries — check dock alignment & plate-distance setting', '#FF3D3D');
        this.autoChargeRetries = 0;
        this.autoChargeOnReach = false;
      }
    }
    if (msg.includes('Joystick') && msg.includes('stopped')) this.setState('idle');

    // ── Patrol state transitions (driven by server log) ──
    // Patrol time-limit ack toasts.
    const limitMatch = msg.match(/patrol\/(set_patrol_time_limit|set_total_time_limit|set_charge_time_limit|set_patrol_number_limit|set_bms_soc_limit|clear_user_config)\/(success|failed)/);
    if (limitMatch) {
      const [, which, result] = limitMatch;
      const human = which.replace('set_', '').replace(/_/g, ' ');
      if (result === 'success') {
        this.showNotification(`Patrol ${human} updated`, '#42CF55');
      } else {
        this.showNotification(`Patrol ${human}: failed`, '#FF3D3D');
      }
    }

    if (msg.includes('patrol/pause/success')) {
      this.patrolPaused = true;
      this.patrolPauseBtn.textContent = 'Resume';
      this.patrolPauseBtn.classList.remove('mapping-btn-warn');
      this.patrolPauseBtn.classList.add('mapping-btn-start');
    }
    if (msg.includes('patrol/go/success')) {
      this.patrolPaused = false;
      this.patrolPauseBtn.textContent = 'Pause';
      this.patrolPauseBtn.classList.remove('mapping-btn-start');
      this.patrolPauseBtn.classList.add('mapping-btn-warn');
    }
    if (msg.includes('patrol/stop/success') || msg.includes('patrol/state_transition/FINISHED')) {
      this.patrolPaused = false;
      this.patrolPauseBtn.textContent = 'Pause';
      this.patrolPauseBtn.classList.remove('mapping-btn-start');
      this.patrolPauseBtn.classList.add('mapping-btn-warn');
      this.setState('localized');
    }
    // ── Live state detail from state_transition messages ──
    this.parseStateTransitions(msg);

    if (msg.includes('localization/stop/success')) {
      this.localized = false;
      this.localizingInProgress = false;
      this.slamScene?.showRobot(false);
      // Clear real-time white point cloud (keep accumulated map)
      this.slamScene?.updateLaserCloud(new Float32Array(0));
      // Unsubscribe localization topics (matching APK)
      for (const topic of LOC_USLAM_TOPICS) {
        this.unsubscribe(topic);
      }
      this.locStartBtn.style.display = '';
      this.locAbortBtn.style.display = 'none';
      this.setLocStatus('', '');
      this.updateFlowGating();
    }

    // ── Patrol points retrieval (patrol/get_patrol_points response) ──
    // Format: patrol/get_patrol_points/point/x/y/yaw/num/N
    const ptMatch = msg.match(/patrol\/get_patrol_points\/point\/([\d.-]+)\/([\d.-]+)\/([\d.-]+)\/num\/(\d+)/);
    if (ptMatch) {
      const x = parseFloat(ptMatch[1]);
      const y = parseFloat(ptMatch[2]);
      const yaw = parseFloat(ptMatch[3]);
      const idx = parseInt(ptMatch[4]);
      // Only add if we don't already have this index
      if (idx >= this.patrolPoints.length) {
        this.patrolPoints.push({ x, y, yaw });
        this.slamScene?.addPatrolMarker(x, y, yaw, this.patrolCount);
        this.patrolCount++;
        this.addLog(`Restored waypoint ${idx + 1}: (${x.toFixed(2)}, ${y.toFixed(2)})`);
      }
    }
    if (msg.includes('patrol/get_patrol_points/sending_end')) {
      this.addLog(`Patrol points restored: ${this.patrolPoints.length} waypoints`);
    }

    // ── Status query responses ──
    const mappingStatusMatch = msg.match(/mapping\/get_status\/status\/(\w+)/);
    if (mappingStatusMatch) {
      const status = mappingStatusMatch[1];
      this.addLog(`Mapping status: ${status === '1' ? 'active' : 'inactive'} (${status})`);
      if (this.mappingStatusResolver) {
        const r = this.mappingStatusResolver;
        this.mappingStatusResolver = null;
        r(status);
      }
    }
    const autoChargeStatusMatch = msg.match(/autocharge\/get_status\/status\/(\w+)/);
    if (autoChargeStatusMatch) {
      const status = autoChargeStatusMatch[1];
      this.addLog(`Autocharge status: ${status === '1' ? 'active' : 'inactive'} (${status})`);
      if (this.autoChargeStatusResolver) {
        const r = this.autoChargeStatusResolver;
        this.autoChargeStatusResolver = null;
        r(status);
      }
    }
    if (msg.includes('autocharge/set_plate_distance/success')) {
      this.showNotification('Plate distance updated', '#42CF55');
    }
    if (msg.includes('autocharge/set_plate_distance/failed')) {
      this.showNotification('Plate distance: failed', '#FF3D3D');
    }
    const locStatusMatch = msg.match(/localization\/get_status\/status\/(\w+)/);
    if (locStatusMatch) {
      const status = locStatusMatch[1];
      this.addLog(`Localization status: ${status === '1' ? 'active' : 'inactive'} (${status})`);
      if (this.locStatusResolver) {
        const r = this.locStatusResolver;
        this.locStatusResolver = null;
        r(status);
      }
    }
    const navStatusMatch = msg.match(/navigation\/get_status\/status\/(\w+)/);
    if (navStatusMatch) {
      const status = navStatusMatch[1];
      this.addLog(`Navigation status: ${status === '1' ? 'active' : 'inactive'} (${status})`);
      if (this.navStatusResolver) {
        const r = this.navStatusResolver;
        this.navStatusResolver = null;
        r(status);
      }
    }
    const patrolStatusMatch = msg.match(/patrol\/get_status\/status\/(\w+)/);
    if (patrolStatusMatch) {
      const status = patrolStatusMatch[1];
      this.addLog(`Patrol status: ${status === '1' ? 'active' : 'inactive'} (${status})`);
      if (this.patrolStatusResolver) {
        const r = this.patrolStatusResolver;
        this.patrolStatusResolver = null;
        r(status);
      }
    }

    // ── Map ID response (manual "Get Current Map ID" only) ──
    if (msg.includes('common/get_map_id/map_id')) {
      const mapId = msg.slice(msg.lastIndexOf('/') + 1);
      if (mapId && mapId !== 'map_id') {
        this.currentMapId = mapId;
        this.mapLoaded = true;
        this.updateFlowGating();
        const input = this.container.querySelector('#map-id-input') as HTMLInputElement;
        if (input) input.value = mapId;
        this.addLog(`Current map ID: ${mapId}`);
        if (this.mapIdResolver) {
          const r = this.mapIdResolver;
          this.mapIdResolver = null;
          r(mapId);
        }
      }
    }

    // After mapping/stop, push our client-minted ID to the robot via set_map_id.
    // The robot does not mint IDs, so without this each new session would
    // collide with the previously-loaded map's ID.
    if (msg.includes('mapping/stop/success') && this.pendingNewMapId) {
      this.pendingSaveAfterStop = true;
      this.sendCmd(`common/set_map_id/${this.pendingNewMapId}`);
      if (this.pendingSaveTimer !== null) clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = window.setTimeout(() => {
        this.pendingSaveTimer = null;
        if (this.pendingSaveAfterStop) {
          this.pendingSaveAfterStop = false;
          this.addLog('Save aborted: set_map_id never confirmed (5s timeout)');
          this.showNotification('Failed to save: robot did not confirm map ID', '#FF3D3D');
        }
      }, 5000);
    }

    // set_map_id confirmation → trigger save with our minted ID.
    // The robot's success message is exactly "common/set_map_id/success"; the
    // word "success" never appears inside a base64 ID, so this match is safe.
    if (this.pendingSaveAfterStop && msg.includes('common/set_map_id/success')) {
      this.pendingSaveAfterStop = false;
      if (this.pendingSaveTimer !== null) { clearTimeout(this.pendingSaveTimer); this.pendingSaveTimer = null; }
      this.currentMapId = this.pendingNewMapId;
      this.pendingNewMapId = '';
      // Slot now holds the freshly-mapped data labelled with this id.
      this.robotSlotMapId = this.currentMapId;
      const input = this.container.querySelector('#map-id-input') as HTMLInputElement;
      if (input) input.value = this.currentMapId;
      this.saveCurrentMap();
    }
    if (this.pendingSaveAfterStop && msg.includes('common/set_map_id/failed')) {
      this.pendingSaveAfterStop = false;
      if (this.pendingSaveTimer !== null) { clearTimeout(this.pendingSaveTimer); this.pendingSaveTimer = null; }
      this.addLog(`set_map_id failed for ${this.pendingNewMapId} — saving locally with this ID anyway`);
      this.currentMapId = this.pendingNewMapId;
      this.pendingNewMapId = '';
      this.saveCurrentMap();
    }
  }

  private handleCloudWorld(data: unknown): void {
    if (!this.slamWorker || !this.workerReady) return;

    const d = data as Record<string, unknown>;
    let buffer: ArrayBuffer | null = null;

    if (d.data instanceof ArrayBuffer) {
      buffer = d.data;
    } else if (data instanceof ArrayBuffer) {
      buffer = data;
    }

    if (!buffer || buffer.byteLength < 6) return;

    // Forward to SLAM worker for dequantization via libvoxel.wasm
    // Worker accumulates and deduplicates points internally
    this.slamWorker.postMessage({
      type: 'newMap',
      data: {
        xmin: d.xmin ?? 0,
        xmax: d.xmax ?? 1,
        ymin: d.ymin ?? 0,
        ymax: d.ymax ?? 1,
        zmin: d.zmin ?? 0,
        zmax: d.zmax ?? 1,
        data: buffer,
      },
    });
  }

  private lastOdomTime = 0;
  private lastTraceX = 0;
  private lastTraceY = 0;

  private handleOdom(data: unknown): void {
    if (!this.slamScene) return;

    // Throttle to 200ms (matching APK)
    const now = performance.now();
    // 50ms throttle matches the APK (20Hz). Lower throttle would let render-side
    // interpolation handle the rest, but the APK relies on the high source rate
    // for visual smoothness, so we mirror that.
    if (now - this.lastOdomTime < 50) return;
    this.lastOdomTime = now;

    const d = data as {
      pose?: { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } } };
    };

    const pos = d.pose?.pose?.position;
    const ori = d.pose?.pose?.orientation;
    if (!pos || !ori) return;

    // Extract yaw from quaternion
    const yaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z));

    // Pass actual odom z — RobotModel applies -0.3 offset (matching APK)
    this.slamScene.updateRobotPose({ x: pos.x, y: pos.y, z: pos.z }, yaw);

    // Only add trace point if moved > 0.1m (matching APK)
    const dx = pos.x - this.lastTraceX;
    const dy = pos.y - this.lastTraceY;
    if (dx * dx + dy * dy > 0.01) { // 0.1^2
      this.slamScene.addTracePoint(pos.x, pos.y, 0);
      this.lastTraceX = pos.x;
      this.lastTraceY = pos.y;
    }
  }

  /**
   * Handle localization real-time clouds and navigation paths.
   * These use PointCloud2 format (ROS2): {width, height, fields, point_step, data}
   */
  private handleLocalizationCloud(data: unknown, type: 'preview' | 'navigation-path' = 'preview'): void {
    if (!this.slamWorker || !this.workerReady) return;

    const d = data as Record<string, unknown>;
    let buffer: ArrayBuffer | null = null;
    if (d.data instanceof ArrayBuffer) {
      buffer = d.data;
    } else if (data instanceof ArrayBuffer) {
      buffer = data;
    }
    if (!buffer) return;

    this.slamWorker.postMessage({
      type,
      data: {
        width: d.width ?? 0,
        height: d.height ?? 1,
        fields: d.fields ?? [],
        point_step: d.point_step ?? 12,
        data: buffer,
      },
    });
  }

  private handleCloudMap(data: unknown): void {
    console.log('[slam] Cloud map received, type:', typeof data,
      data instanceof ArrayBuffer ? `ArrayBuffer(${data.byteLength})` : '');

    // PCD data may arrive as binary ArrayBuffer or nested in data.data
    let buffer: ArrayBuffer | null = null;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (d.data instanceof ArrayBuffer) {
        buffer = d.data;
      }
    }

    if (buffer) {
      // Offer download as .pcd file
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `go2_map_${Date.now()}.pcd`;
      a.click();
      URL.revokeObjectURL(url);
      this.addLog(`Map downloaded: ${a.download} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);

      // Also try to load it as point cloud for visualization
      try {
        const positions = new Float32Array(buffer);
        if (positions.length >= 3) {
          this.slamScene?.updatePointCloud(positions);
          this.addLog(`Map loaded: ${positions.length / 3} points`);
        }
      } catch {
        this.addLog('Map data format not recognized as raw Float32 points');
      }
    }
  }

  // ── Saved Maps (localStorage) ──

  private static STORAGE_KEY = 'go2_slam_maps';

  /**
   * 16 random bytes as URL-safe base64. Format matches the IDs the robot
   * already accepts (e.g. "ixPTqIMgyu_0HY5q9MxGFw") — 22 chars, A-Z a-z 0-9 - _.
   */
  private static generateMapId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private getSavedMaps(): Array<{ id: string; name: string; date: string }> {
    try {
      return JSON.parse(localStorage.getItem(MappingPage.STORAGE_KEY) || '[]');
    } catch { return []; }
  }

  private saveMapsToStorage(maps: Array<{ id: string; name: string; date: string }>): void {
    localStorage.setItem(MappingPage.STORAGE_KEY, JSON.stringify(maps));
  }

  private saveCurrentMap(): void {
    if (!this.currentMapId) {
      this.addLog('No map ID available yet — waiting...');
      return;
    }
    // Snapshot the id so a later get_map_id response can't shift it under us
    const idAtPrompt = this.currentMapId;
    const maps = this.getSavedMaps();
    const collision = maps.find((m) => m.id === idAtPrompt);
    const now = new Date();
    const defaultName = collision
      ? collision.name
      : `Map ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const title = collision ? 'Update Existing Map' : 'Save Map';
    const label = collision
      ? `This ID already exists as "${collision.name}". Save will overwrite it. New name:`
      : 'Enter map name:';
    this.showInputModal(title, label, defaultName, (name) => {
      if (!name) return;
      const cur = this.getSavedMaps();
      const existing = cur.findIndex((m) => m.id === idAtPrompt);
      const entry = { id: idAtPrompt, name, date: new Date().toISOString() };
      if (existing >= 0) {
        cur[existing] = entry;
      } else {
        cur.push(entry);
      }
      this.saveMapsToStorage(cur);
      this.renderSavedMaps();
      this.addLog(`Map saved: "${name}" (${idAtPrompt})`);
      // Cache the full file set (.pcd, .pgm, .txt). The robot has one slot,
      // so we need the full set to re-upload via push_static_file later.
      void this.cacheBundleFromRobot(idAtPrompt);
    });
  }

  private fetchRobotFile(filePath: string): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      if (!this.requestFile) { resolve(null); return; }
      this.requestFile(filePath, (b64) => {
        if (!b64) { resolve(null); return; }
        try { resolve(base64ToBytes(b64)); }
        catch { resolve(null); }
      });
    });
  }

  private async cacheBundleFromRobot(mapId: string): Promise<void> {
    if (!this.requestFile) {
      this.addLog('Cannot cache map: requestFile not available');
      return;
    }
    this.addLog('Caching map files locally...');
    // Sequential: requestFile installs a single onTopicData handler, so two
    // concurrent calls clobber each other's response routing.
    const pcd = await this.fetchRobotFile('map.pcd');
    if (!pcd) {
      this.addLog('Cache failed: map.pcd not received from robot');
      return;
    }
    const pgm = await this.fetchRobotFile('map.pgm');
    const txt = await this.fetchRobotFile('map.txt');
    const bundle: MapBundle = { pcd };
    if (pgm) bundle.pgm = pgm;
    if (txt) bundle.txt = txt;
    try {
      await putBundle(mapId, bundle);
      const summary = `pcd=${(pcd.byteLength / 1024).toFixed(1)}KB`
        + (pgm ? ` pgm=${(pgm.byteLength / 1024).toFixed(1)}KB` : ' pgm=missing')
        + (txt ? ` txt=${txt.byteLength}B` : ' txt=missing');
      this.addLog(`Map cached locally (${summary})`);
      this.renderSavedMaps();
    } catch (err) {
      this.addLog(`Cache failed: ${err}`);
    }
  }

  private async loadMap(mapId: string): Promise<void> {
    this.addLog(`Loading map ${mapId}...`);
    this.slamScene?.clearAll();
    this.slamWorker?.postMessage('clear');
    this.patrolPoints = [];
    this.patrolCount = 0;
    this.currentMapId = mapId;

    let bundle: MapBundle | null;
    try { bundle = await getBundle(mapId); }
    catch (err) { this.addLog(`Cache lookup failed: ${err}`); return; }

    // Render the PCD immediately from cache for fast feedback.
    if (bundle?.pcd) {
      this.slamScene?.clearLoadedPcd();
      this.slamScene?.loadPCD(bundle.pcd);
      this.addLog(`Viewer: rendered cached PCD (${(bundle.pcd.byteLength / 1024).toFixed(1)} KB)`);
    }

    // Push the full file set to the robot's single slot, then activate it.
    if (bundle?.pcd && this.pushFile) {
      if (this.robotSlotMapId === mapId) {
        this.addLog(`Robot slot already holds ${mapId} — skipping upload`);
        // Still send set_map_id in case the active label drifted.
        this.sendCmd(`common/set_map_id/${mapId}`);
        return;
      }
      try {
        await this.uploadBundleToRobot(bundle);
        this.sendCmd(`common/set_map_id/${mapId}`);
        this.robotSlotMapId = mapId;
        this.addLog(`Map ${mapId} activated on robot`);
      } catch (err) {
        // Upload was interrupted — the robot's slot is in an unknown state now.
        this.robotSlotMapId = '';
        this.addLog(`Upload failed: ${err}. Localization on this map will not work.`);
      }
      return;
    }

    // No cached bundle: render whatever's currently on the robot but DO NOT
    // cache it — set_map_id only relabels, the actual files might be from a
    // different mapping session, so caching them under this id corrupts the cache.
    if (!bundle?.pcd) {
      this.addLog('No local cache for this id — rendering robot\'s current slot (may differ from this map)');
      this.sendCmd(`common/set_map_id/${mapId}`);
      const pcd = await this.fetchRobotFile('map.pcd');
      if (pcd) {
        this.slamScene?.clearLoadedPcd();
        this.slamScene?.loadPCD(pcd);
        this.addLog(`Viewer: PCD from robot's current slot (${(pcd.byteLength / 1024).toFixed(1)} KB) — NOT cached`);
      } else {
        this.addLog('Failed to fetch PCD from robot');
      }
    }
  }

  private async exportMapZip(mapId: string): Promise<void> {
    const meta = this.getSavedMaps().find((m) => m.id === mapId);
    if (!meta) { this.addLog(`Export failed: ${mapId} not in saved list`); return; }
    let bundle: MapBundle | null;
    try { bundle = await getBundle(mapId); }
    catch (err) { this.addLog(`Export failed: cache lookup ${err}`); return; }
    if (!bundle?.pcd) {
      this.addLog(`Export failed: no cached PCD for ${mapId}. Load it once first to populate the cache.`);
      return;
    }
    try {
      const zip = bundleToZip(meta, bundle);
      const safeName = meta.name.replace(/[^\w.\-]+/g, '_').slice(0, 60) || mapId;
      downloadBlob(`${safeName}.zip`, zip);
      this.addLog(`Exported ${safeName}.zip (${(zip.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      this.addLog(`Export failed: ${err}`);
    }
  }

  private importMapZip(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const { meta, bundle } = zipToBundle(new Uint8Array(buf));
        // Generate any missing fields client-side.
        const id = meta.id || MappingPage.generateMapId();
        const collisionWith = this.getSavedMaps().find((m) => m.id === id);
        const promptName = meta.name || file.name.replace(/\.zip$/i, '') || `Imported ${new Date().toLocaleString()}`;
        const title = collisionWith ? 'Update Existing Map' : 'Import Map';
        const label = collisionWith
          ? `ID ${id} already exists as "${collisionWith.name}". Save will overwrite it. Name:`
          : 'Map name:';
        this.showInputModal(title, label, promptName, async (name) => {
          if (!name) return;
          try {
            await putBundle(id, bundle);
            const maps = this.getSavedMaps();
            const idx = maps.findIndex((m) => m.id === id);
            const entry = { id, name, date: meta.date || new Date().toISOString() };
            if (idx >= 0) maps[idx] = entry; else maps.push(entry);
            this.saveMapsToStorage(maps);
            this.renderSavedMaps();
            // Imported bundle differs from whatever's on the robot now.
            if (this.robotSlotMapId === id) this.robotSlotMapId = '';
            const sizes = `pcd=${(bundle.pcd.byteLength / 1024).toFixed(1)}KB`
              + (bundle.pgm ? ` pgm=${(bundle.pgm.byteLength / 1024).toFixed(1)}KB` : '')
              + (bundle.txt ? ` txt=${bundle.txt.byteLength}B` : '');
            this.addLog(`Imported "${name}" (${id}) — ${sizes}`);
          } catch (err) {
            this.addLog(`Import failed: ${err}`);
          }
        });
      } catch (err) {
        this.addLog(`Import failed: ${err}`);
      }
    });
    input.click();
  }

  private async uploadBundleToRobot(bundle: MapBundle): Promise<void> {
    if (!this.pushFile) throw new Error('pushFile not available');
    const tasks: Array<[string, ArrayBuffer]> = [['map.pcd', bundle.pcd]];
    if (bundle.pgm) tasks.push(['map.pgm', bundle.pgm]);
    if (bundle.txt) tasks.push(['map.txt', bundle.txt]);
    for (const [name, buf] of tasks) {
      const b64 = bytesToBase64(buf);
      this.addLog(`Uploading ${name} (${(buf.byteLength / 1024).toFixed(1)} KB)...`);
      await this.pushFile(name, b64, (frac) => {
        // Coarse progress in the log, every ~25%
        const pct = Math.round(frac * 100);
        if (pct % 25 === 0) this.addLog(`  ${name}: ${pct}%`);
      });
      this.addLog(`  ${name}: done`);
    }
  }

  private renameMap(mapId: string): void {
    const maps = this.getSavedMaps();
    const map = maps.find((m) => m.id === mapId);
    if (!map) return;
    this.showInputModal('Rename Map', 'New name:', map.name, (newName) => {
      if (!newName || newName === map.name) return;
      map.name = newName;
      this.saveMapsToStorage(maps);
      this.renderSavedMaps();
    });
  }

  private deleteMap(mapId: string): void {
    const maps = this.getSavedMaps();
    const map = maps.find((m) => m.id === mapId);
    if (!map) return;
    this.showConfirmModal(`Delete "${map.name}"?`, () => {
      this.saveMapsToStorage(maps.filter((m) => m.id !== mapId));
      this.renderSavedMaps();
      deleteBundle(mapId).catch(() => { /* non-fatal */ });
      this.addLog(`Map "${map.name}" removed`);
    });
  }

  private renderSavedMaps(): void {
    if (!this.savedMapsEl) return;
    const maps = this.getSavedMaps();

    if (maps.length === 0) {
      this.savedMapsEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'mapping-empty';
      empty.textContent = 'No saved maps';
      this.savedMapsEl.appendChild(empty);
      return;
    }

    this.savedMapsEl.innerHTML = '';
    for (const map of maps) {
      const row = document.createElement('div');
      row.className = 'mapping-map-row';

      const info = document.createElement('div');
      info.className = 'mapping-map-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'mapping-map-name';
      nameEl.textContent = map.name;
      info.appendChild(nameEl);
      const dateEl = document.createElement('span');
      dateEl.className = 'mapping-map-date';
      dateEl.textContent = new Date(map.date).toLocaleString();
      info.appendChild(dateEl);

      // Map ID shown on hover
      const idEl = document.createElement('span');
      idEl.className = 'mapping-map-id';
      idEl.textContent = `ID: ${map.id}`;
      info.appendChild(idEl);

      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'mapping-map-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'mapping-btn mapping-btn-sm';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => { void this.loadMap(map.id); });
      actions.appendChild(loadBtn);

      const renameBtn = document.createElement('button');
      renameBtn.className = 'mapping-btn mapping-btn-sm';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => this.renameMap(map.id));
      actions.appendChild(renameBtn);

      const exportBtn = document.createElement('button');
      exportBtn.className = 'mapping-btn mapping-btn-sm';
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', () => { void this.exportMapZip(map.id); });
      actions.appendChild(exportBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'mapping-btn mapping-btn-sm mapping-btn-stop';
      delBtn.textContent = 'Del';
      delBtn.addEventListener('click', () => this.deleteMap(map.id));
      actions.appendChild(delBtn);

      row.appendChild(actions);
      this.savedMapsEl.appendChild(row);
    }
  }

  // ── Non-blocking Modals (won't freeze heartbeat) ──

  private showInputModal(title: string, label: string, defaultVal: string, onOk: (val: string) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'mapping-modal-overlay';
    overlay.innerHTML = `
      <div class="mapping-modal">
        <div class="mapping-modal-title">${title}</div>
        <label class="mapping-modal-label">${label}</label>
        <input class="mapping-input mapping-modal-input" value="${defaultVal}" />
        <div class="mapping-modal-btns">
          <button class="mapping-btn mapping-modal-cancel">Cancel</button>
          <button class="mapping-btn mapping-btn-start mapping-modal-ok">Save</button>
        </div>
      </div>
    `;
    this.container.appendChild(overlay);
    const input = overlay.querySelector('.mapping-modal-input') as HTMLInputElement;
    input.focus();
    input.select();
    overlay.querySelector('.mapping-modal-cancel')!.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.mapping-modal-ok')!.addEventListener('click', () => {
      const val = input.value.trim();
      overlay.remove();
      if (val) onOk(val);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { overlay.querySelector<HTMLButtonElement>('.mapping-modal-ok')!.click(); }
      if (e.key === 'Escape') { overlay.remove(); }
    });
  }

  private showConfirmModal(message: string, onOk: () => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'mapping-modal-overlay';
    overlay.innerHTML = `
      <div class="mapping-modal">
        <div class="mapping-modal-title">${message}</div>
        <div class="mapping-modal-btns">
          <button class="mapping-btn mapping-modal-cancel">Cancel</button>
          <button class="mapping-btn mapping-btn-stop mapping-modal-ok">Delete</button>
        </div>
      </div>
    `;
    this.container.appendChild(overlay);
    overlay.querySelector('.mapping-modal-cancel')!.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.mapping-modal-ok')!.addEventListener('click', () => { overlay.remove(); onOk(); });
  }

  // ── Cleanup ──

  private cleanup(): void {
    for (const topic of BASE_USLAM_TOPICS) this.unsubscribe(topic);
    for (const topic of LOC_USLAM_TOPICS) this.unsubscribe(topic);
  }

  destroy(): void {
    this.cleanup();
    this.slamWorker?.terminate();
    this.slamWorker = null;
    this.slamScene?.destroy();
    this.slamScene = null;
    this.unsubTheme?.();
    this.unsubTheme = null;
    this.pipCamera?.destroy();
    this.pipCamera = null;
  }
}

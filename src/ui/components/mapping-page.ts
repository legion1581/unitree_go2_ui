import { SlamScene, type ClickMode } from '../scene/slam-scene';
import { RTC_TOPIC } from '../../protocol/topics';
import SlamWorker from '../../workers/slam-worker?worker';

type SlamState = 'idle' | 'mapping' | 'localized' | 'navigating' | 'patrolling';

// Topics subscribed on entry (mapping + server log)
const BASE_USLAM_TOPICS = [
  RTC_TOPIC.USLAM_SERVER_LOG,
  RTC_TOPIC.USLAM_CLOUD_WORLD,
  RTC_TOPIC.USLAM_ODOM,
  RTC_TOPIC.USLAM_CLOUD_MAP,
  RTC_TOPIC.USLAM_GRID_MAP,
];

// Topics subscribed only after localization succeeds (matching APK)
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
  private logEl!: HTMLElement;
  private activeClickBtn: HTMLButtonElement | null = null;
  private patrolCount = 0;
  private patrolPoints: Array<{ x: number; y: number; yaw: number }> = [];
  private slamWorker: Worker | null = null;
  private workerReady = false;
  private requestFile: ((path: string, cb: (data: string | null) => void) => void) | null = null;
  private savedMapsEl!: HTMLElement;
  private currentMapId = '';

  // Flow gating state
  private mapLoaded = false;
  private localized = false;
  private localizingInProgress = false;

  // Section references for enabling/disabling
  private locSection!: HTMLElement;
  private navSection!: HTMLElement;
  private locHint!: HTMLElement;
  private navHint!: HTMLElement;

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
  ) {
    this.onBack = onBack;
    this.publish = onPublish;
    this.subscribe = onSubscribe;
    this.unsubscribe = onUnsubscribe;
    this.requestFile = onRequestFile ?? null;

    this.container = document.createElement('div');
    this.container.className = 'mapping-page';

    // Header
    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', () => {
      this.cleanup();
      onBack();
    });
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = '3D LiDAR Mapping';
    header.appendChild(title);
    this.container.appendChild(header);

    // Body: viewport + sidebar
    const body = document.createElement('div');
    body.className = 'mapping-body';

    // 3D Viewport
    const viewport = document.createElement('div');
    viewport.className = 'mapping-viewport';
    const canvas = document.createElement('canvas');
    canvas.className = 'mapping-canvas';
    viewport.appendChild(canvas);
    body.appendChild(viewport);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.className = 'mapping-sidebar';
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
  }

  private buildSidebar(sidebar: HTMLElement): void {
    // ── Status ──
    sidebar.appendChild(this.buildSection('Status', (body) => {
      this.stateEl = document.createElement('div');
      this.stateEl.className = 'mapping-state';
      this.updateStateDisplay();
      body.appendChild(this.stateEl);
    }));

    // ── Step 1: Map ──
    sidebar.appendChild(this.buildSection('Step 1: Map', (body) => {
      // ── Create New ──
      const createLabel = document.createElement('div');
      createLabel.className = 'mapping-subsection-title';
      createLabel.textContent = 'Create New';
      body.appendChild(createLabel);

      const row = document.createElement('div');
      row.className = 'mapping-btn-row';
      row.appendChild(this.btn('New Map', 'mapping-btn-start', () => {
        this.slamScene?.clearPointCloud();
        this.slamScene?.clearTrace();
        this.slamWorker?.postMessage('clear');
        this.sendCmd('mapping/start');
        this.setState('mapping');
      }));
      row.appendChild(this.btn('Stop & Save', 'mapping-btn-stop', () => {
        this.sendCmd('mapping/stop');
        this.setState('idle');
      }));
      body.appendChild(row);

      // ── Saved Maps ──
      const savedLabel = document.createElement('div');
      savedLabel.className = 'mapping-subsection-title';
      savedLabel.textContent = 'Saved Maps';
      savedLabel.style.marginTop = '10px';
      body.appendChild(savedLabel);

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
      this.locSetPoseBtn = this.clickModeBtn('Set Initial Pose (click + drag on map)', 'initial_pose');
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

      // ── Go to Goal sub-section ──
      const goalLabel = document.createElement('div');
      goalLabel.className = 'mapping-subsection-title';
      goalLabel.textContent = 'Go to Goal';
      body.appendChild(goalLabel);

      body.appendChild(this.clickModeBtn('Set Goal (click + drag on map)', 'goal'));
      const goalRow = document.createElement('div');
      goalRow.className = 'mapping-btn-row';
      goalRow.appendChild(this.btn('Navigate to Goal', 'mapping-btn-start', () => {
        this.sendCmd('navigation/start');
        this.setState('navigating');
      }));
      goalRow.appendChild(this.btn('Go to Charging Station', '', () => {
        this.sendCmd('navigation/start');
        setTimeout(() => {
          this.sendCmd('navigation/set_goal_pose/-0.150/0.000/0.000');
          this.addLog('Navigating to charging station...');
        }, 1000);
        this.setState('navigating');
      }));
      body.appendChild(goalRow);
      body.appendChild(this.btn('Stop Navigation', 'mapping-btn-stop', () => {
        this.sendCmd('navigation/stop');
        this.slamScene?.clearNavPath();
        this.setState('localized');
      }));

      // ── Patrol sub-section ──
      const patrolLabel = document.createElement('div');
      patrolLabel.className = 'mapping-subsection-title';
      patrolLabel.textContent = 'Patrol';
      patrolLabel.style.marginTop = '10px';
      body.appendChild(patrolLabel);

      body.appendChild(this.clickModeBtn('Add Waypoint (click + drag on map)', 'patrol'));
      body.appendChild(this.btn('Clear All Waypoints', 'mapping-btn-warn', () => {
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
      patrolCtrlRow.appendChild(this.btn('Pause', '', () => this.sendCmd('patrol/pause')));
      body.appendChild(patrolCtrlRow);
      const patrolCtrlRow2 = document.createElement('div');
      patrolCtrlRow2.className = 'mapping-btn-row';
      patrolCtrlRow2.appendChild(this.btn('Resume', '', () => this.sendCmd('patrol/go')));
      patrolCtrlRow2.appendChild(this.btn('Stop Patrol', 'mapping-btn-stop', () => {
        this.sendCmd('patrol/stop');
        this.setState('localized');
      }));
      body.appendChild(patrolCtrlRow2);
    });
    sidebar.appendChild(this.navSection);

    // ── Server Log ──
    sidebar.appendChild(this.buildSection('Server Log', (body) => {
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
        this.sendCmd(`navigation/set_goal_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.addLog(`Goal set: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${yawDeg}`);
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        break;

      case 'patrol':
        this.patrolPoints.push({ x, y, yaw });
        this.slamScene?.addPatrolMarker(x, y, yaw, this.patrolCount);
        this.patrolCount++;
        this.addLog(`Waypoint ${this.patrolCount}: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${yawDeg}`);
        // Keep patrol click mode active for adding multiple points
        break;
    }
  }

  // ── Patrol Execution (matches APK flow) ──

  private async executePatrol(): Promise<void> {
    if (this.patrolPoints.length < 2) {
      this.addLog('Need at least 2 waypoints to start patrol');
      this.showNotification('Add at least 2 waypoints before executing patrol', '#FCD335');
      return;
    }

    this.addLog(`Executing patrol with ${this.patrolPoints.length} waypoints...`);

    // Step 1: Clear all existing points on robot
    this.sendCmd('patrol/clear_all_patrol_points');
    await this.delay(200);

    // Step 2: Re-add all points with yaw - PI adjustment (matches APK)
    for (const pt of this.patrolPoints) {
      const adjustedYaw = pt.yaw - Math.PI;
      this.sendCmd(`patrol/add_patrol_point/${pt.x.toFixed(3)}/${pt.y.toFixed(3)}/${adjustedYaw.toFixed(3)}`);
      await this.delay(100);
    }

    // Step 3: Set time limits (default: unlimited total, 30s per point, 0 charge)
    this.sendCmd('patrol/set_total_time_limit/-1');
    this.sendCmd('patrol/set_patrol_time_limit/30');
    this.sendCmd('patrol/set_charge_time_limit/0');
    await this.delay(100);

    // Step 4: Start patrol
    this.sendCmd('patrol/start');
    await this.delay(200);

    // Step 5: Go
    this.sendCmd('patrol/go');
    this.setState('patrolling');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  private setState(s: SlamState): void {
    this.state = s;
    this.updateStateDisplay();
  }

  private updateStateDisplay(): void {
    if (!this.stateEl) return;
    const colors: Record<SlamState, string> = {
      idle: '#888',
      mapping: '#42CF55',
      localized: '#6879e4',
      navigating: '#FCD335',
      patrolling: '#66E7BE',
    };
    const labels: Record<SlamState, string> = {
      idle: 'Idle',
      mapping: 'Mapping...',
      localized: 'Localized',
      navigating: 'Navigating...',
      patrolling: 'Patrolling...',
    };
    this.stateEl.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'mapping-state-dot';
    dot.style.background = colors[this.state];
    if (this.state !== 'idle') dot.style.boxShadow = `0 0 6px ${colors[this.state]}`;
    this.stateEl.appendChild(dot);
    const lbl = document.createElement('span');
    lbl.textContent = labels[this.state];
    lbl.style.color = colors[this.state];
    this.stateEl.appendChild(lbl);
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

    // ── Navigation state transitions ──
    if (msg.includes('REACHED')) {
      this.setState('localized');
      this.slamScene?.clearNavPath();
      this.showNotification('Navigation goal reached', '#42CF55');
    }
    if (msg.includes('Joystick') && msg.includes('stopped')) this.setState('idle');
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

    // ── Map ID response ──
    if (msg.includes('common/get_map_id/map_id')) {
      const mapId = msg.slice(msg.lastIndexOf('/') + 1);
      if (mapId && mapId !== 'map_id') {
        this.currentMapId = mapId;
        this.mapLoaded = true;
        this.updateFlowGating();
        const input = this.container.querySelector('#map-id-input') as HTMLInputElement;
        if (input) input.value = mapId;
        this.addLog(`Current map ID: ${mapId}`);
      }
    }

    // After mapping stops, get the map ID so user can save it
    if (msg.includes('mapping/stop/success')) {
      this.sendCmd('common/get_map_id');
      setTimeout(() => this.saveCurrentMap(), 1500);
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
    if (now - this.lastOdomTime < 200) return;
    this.lastOdomTime = now;

    const d = data as {
      pose?: { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } } };
    };

    const pos = d.pose?.pose?.position;
    const ori = d.pose?.pose?.orientation;
    if (!pos || !ori) return;

    // Extract yaw from quaternion
    const yaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z));

    // Update robot marker (z forced to 0 for flat display, matching APK)
    this.slamScene.updateRobotPose({ x: pos.x, y: pos.y, z: 0 }, yaw);

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
    const now = new Date();
    const defaultName = `Map ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    this.showInputModal('Save Map', 'Enter map name:', defaultName, (name) => {
      if (!name) return;
      const maps = this.getSavedMaps();
      const existing = maps.findIndex((m) => m.id === this.currentMapId);
      const entry = { id: this.currentMapId, name, date: new Date().toISOString() };
      if (existing >= 0) {
        maps[existing] = entry;
      } else {
        maps.push(entry);
      }
      this.saveMapsToStorage(maps);
      this.renderSavedMaps();
      this.addLog(`Map saved: "${name}" (${this.currentMapId})`);
    });
  }

  private loadMap(mapId: string): void {
    this.addLog(`Loading map ${mapId}...`);
    // Map ID is already base64 from the robot — send as-is
    this.sendCmd(`common/set_map_id/${mapId}`);
    this.currentMapId = mapId;

    // Fetch PCD file for preview (APK uses "map.pcd" with related_bussiness context)
    if (this.requestFile) {
      this.addLog('Requesting PCD file...');
      this.requestFile('map.pcd', (data) => {
        if (data) {
          this.addLog(`PCD received (${(data.length * 0.75 / 1024).toFixed(1)} KB)`);
          try {
            // Convert base64 to ArrayBuffer
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            this.slamScene?.clearLoadedPcd();
            this.slamScene?.loadPCD(bytes.buffer);
            this.addLog('Map loaded in viewer');
          } catch (err) {
            this.addLog(`Failed to load PCD: ${err}`);
            console.error('[slam] PCD error:', err);
          }
        } else {
          this.addLog('Failed to fetch PCD file (timeout or not found)');
        }
      });
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
      loadBtn.addEventListener('click', () => this.loadMap(map.id));
      actions.appendChild(loadBtn);

      const renameBtn = document.createElement('button');
      renameBtn.className = 'mapping-btn mapping-btn-sm';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => this.renameMap(map.id));
      actions.appendChild(renameBtn);

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
  }
}

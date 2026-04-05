import { SlamScene, type ClickMode } from '../scene/slam-scene';
import { RTC_TOPIC } from '../../protocol/topics';
import SlamWorker from '../../workers/slam-worker?worker';

type SlamState = 'idle' | 'mapping' | 'localized' | 'navigating' | 'patrolling';

const ALL_USLAM_TOPICS = [
  RTC_TOPIC.USLAM_SERVER_LOG,
  RTC_TOPIC.USLAM_CLOUD_WORLD,
  RTC_TOPIC.USLAM_ODOM,
  RTC_TOPIC.USLAM_CLOUD_MAP,
  RTC_TOPIC.USLAM_GRID_MAP,
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
  private slamWorker: Worker | null = null;
  private workerReady = false;
  private requestFile: ((path: string, cb: (data: string | null) => void) => void) | null = null;
  private savedMapsEl!: HTMLElement;
  private currentMapId = '';

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
      this.slamScene.onMapClick = (x, y) => this.handleMapClick(x, y);
      this.slamScene.onPoseSet = (x, y, yaw) => this.handlePoseSet(x, y, yaw);
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
        // Localization real-time point cloud (white, not accumulated)
        const { points } = msg.data as { points: Float32Array };
        this.slamScene?.updateLaserCloud(points);
      } else if (msg.type === 'navigation-path') {
        // Red navigation path
        const { points } = msg.data as { points: Float32Array };
        this.slamScene?.updateNavPath(points);
      }
    };

    // Subscribe to all USLAM topics on entry
    // (localization data only processed after localization succeeds)
    for (const topic of ALL_USLAM_TOPICS) {
      this.subscribe(topic);
    }
  }

  private buildSidebar(sidebar: HTMLElement): void {
    // Status section
    sidebar.appendChild(this.buildSection('Status', (body) => {
      this.stateEl = document.createElement('div');
      this.stateEl.className = 'mapping-state';
      this.updateStateDisplay();
      body.appendChild(this.stateEl);
    }));

    // Map Management section
    sidebar.appendChild(this.buildSection('Map', (body) => {
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

      // Map ID input for loading saved maps
      const mapIdRow = document.createElement('div');
      mapIdRow.className = 'mapping-map-id-row';
      const mapIdInput = document.createElement('input');
      mapIdInput.className = 'mapping-input';
      mapIdInput.placeholder = 'Map ID';
      mapIdInput.id = 'map-id-input';
      mapIdRow.appendChild(mapIdInput);
      const loadBtn = this.btn('Load', '', () => {
        const id = mapIdInput.value.trim();
        if (id) {
          // Map ID is already base64 — send as-is
          this.sendCmd(`common/set_map_id/${id}`);
          this.addLog(`Loading map: ${id}`);
        }
      });
      loadBtn.style.width = 'auto';
      loadBtn.style.minWidth = '60px';
      mapIdRow.appendChild(loadBtn);
      body.appendChild(mapIdRow);

      const getIdBtn = this.btn('Get Current Map ID', '', () => {
        this.sendCmd('common/get_map_id');
      });
      body.appendChild(getIdBtn);
    }));

    // Localization section
    sidebar.appendChild(this.buildSection('Localization', (body) => {
      body.appendChild(this.clickModeBtn('Set Initial Pose', 'initial_pose'));
      body.appendChild(this.btn('Start Localization', '', () => {
        this.sendCmd('localization/start');
        this.setState('localized');
      }));
      body.appendChild(this.btn('Stop Localization', '', () => {
        this.sendCmd('localization/stop');
        this.setState('idle');
      }));
    }));

    // Navigation section (Go + Charge)
    sidebar.appendChild(this.buildSection('Navigation', (body) => {
      body.appendChild(this.clickModeBtn('Set Goal', 'goal'));
      const navRow = document.createElement('div');
      navRow.className = 'mapping-btn-row';
      navRow.appendChild(this.btn('Go', 'mapping-btn-start', () => {
        this.sendCmd('navigation/start');
        this.setState('navigating');
      }));
      navRow.appendChild(this.btn('Charge', '', () => {
        // Navigate to charging dock (odom origin [-0.15, 0])
        this.sendCmd('navigation/start');
        setTimeout(() => {
          this.sendCmd('navigation/set_goal_pose/-0.150/0.000/0.000');
          this.addLog('Navigating to charge dock...');
        }, 1000);
        this.setState('navigating');
      }));
      body.appendChild(navRow);
      body.appendChild(this.btn('Stop Navigation', 'mapping-btn-stop', () => {
        this.sendCmd('navigation/stop');
        this.slamScene?.clearNavPath();
        this.setState('localized');
      }));
    }));

    // Patrol section
    sidebar.appendChild(this.buildSection('Patrol', (body) => {
      body.appendChild(this.clickModeBtn('Add Waypoint', 'patrol'));
      body.appendChild(this.btn('Clear All', 'mapping-btn-warn', () => {
        this.sendCmd('patrol/clear_all_patrol_points');
        this.slamScene?.clearPatrolMarkers();
        this.patrolCount = 0;
      }));
      const row = document.createElement('div');
      row.className = 'mapping-btn-row';
      row.appendChild(this.btn('Start', '', () => {
        this.sendCmd('patrol/start');
        this.setState('patrolling');
      }));
      row.appendChild(this.btn('Pause', '', () => this.sendCmd('patrol/pause')));
      row.appendChild(this.btn('Go', '', () => this.sendCmd('patrol/go')));
      row.appendChild(this.btn('Stop', 'mapping-btn-stop', () => {
        this.sendCmd('patrol/stop');
        this.setState('idle');
      }));
      body.appendChild(row);
    }));

    // Saved Maps section
    sidebar.appendChild(this.buildSection('Saved Maps', (body) => {
      this.savedMapsEl = document.createElement('div');
      this.savedMapsEl.className = 'mapping-saved-list';
      body.appendChild(this.savedMapsEl);
      this.renderSavedMaps();
    }));

    // Server Log section
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

  private handleMapClick(x: number, y: number): void {
    const mode = this.activeClickBtn ? this.slamScene?.['clickMode'] as ClickMode : 'none';
    const yaw = 0; // default yaw for v1

    switch (mode) {
      case 'initial_pose':
        // Handled by onPoseSet drag callback instead
        break;

      case 'goal':
        this.sendCmd(`navigation/set_goal_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.addLog(`Goal set: (${x.toFixed(2)}, ${y.toFixed(2)})`);
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        this.slamScene?.setClickMode('none');
        break;

      case 'patrol':
        this.sendCmd(`patrol/add_patrol_point/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.slamScene?.addPatrolMarker(x, y, yaw, this.patrolCount);
        this.patrolCount++;
        this.addLog(`Waypoint ${this.patrolCount} added: (${x.toFixed(2)}, ${y.toFixed(2)})`);
        // Keep patrol click mode active for adding multiple points
        break;
    }
  }

  /** Called when user clicks + drags to set initial pose with orientation */
  private handlePoseSet(x: number, y: number, yaw: number): void {
    this.sendCmd(`localization/set_initial_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
    this.addLog(`Initial pose: (${x.toFixed(2)}, ${y.toFixed(2)}) yaw=${(yaw * 180 / Math.PI).toFixed(1)}°`);
    // Deactivate click mode button
    this.activeClickBtn?.classList.remove('active');
    this.activeClickBtn = null;
    // Auto-start localization after setting pose
    setTimeout(() => {
      this.sendCmd('localization/start');
    }, 100);
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
        if (this.state === 'localized' || this.state === 'navigating' || this.state === 'patrolling') {
          this.handleOdom(data);
        }
        break;
      case RTC_TOPIC.USLAM_LOC_CLOUD:
        if (this.state === 'localized' || this.state === 'navigating' || this.state === 'patrolling') {
          this.handleLocalizationCloud(data);
        }
        break;
      case RTC_TOPIC.USLAM_NAV_PATH:
        if (this.state === 'localized' || this.state === 'navigating' || this.state === 'patrolling') {
          this.handleLocalizationCloud(data, 'navigation-path');
        }
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

    // State transitions from server messages
    if (msg.includes('mapping/stop/success')) this.setState('idle');
    if (msg.includes('mapping/start/success')) this.setState('mapping');
    if (msg.includes('localization') && msg.includes('succeed')) {
      this.setState('localized');
      this.slamScene?.showRobot(true);
      this.addLog('Localization successful — robot visible on map');
    }
    if (msg.includes('localization') && msg.includes('failed')) {
      this.setState('idle');
      this.addLog('Localization failed');
    }
    if (msg.includes('REACHED')) {
      this.setState('localized');
      this.slamScene?.clearNavPath();
      this.addLog('Navigation goal reached');
    }
    if (msg.includes('Joystick') && msg.includes('stopped')) this.setState('idle');
    if (msg.includes('localization/stop/success')) {
      this.slamScene?.showRobot(false);
    }

    // Map ID response: "common/get_map_id/map_id/{mapId}"
    if (msg.includes('common/get_map_id/map_id')) {
      const mapId = msg.slice(msg.lastIndexOf('/') + 1);
      if (mapId && mapId !== 'map_id') {
        this.currentMapId = mapId;
        const input = this.container.querySelector('#map-id-input') as HTMLInputElement;
        if (input) input.value = mapId;
        this.addLog(`Current map ID: ${mapId}`);
      }
    }

    // After mapping stops, get the map ID so user can save it
    if (msg.includes('mapping/stop/success')) {
      this.sendCmd('common/get_map_id');
      // Prompt save after a short delay to let map ID arrive
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
    for (const topic of ALL_USLAM_TOPICS) this.unsubscribe(topic);
  }

  destroy(): void {
    this.cleanup();
    this.slamWorker?.terminate();
    this.slamWorker = null;
    this.slamScene?.destroy();
    this.slamScene = null;
  }
}

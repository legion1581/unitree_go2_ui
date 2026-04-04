import { SlamScene, type ClickMode } from '../scene/slam-scene';
import { RTC_TOPIC } from '../../protocol/topics';

type SlamState = 'idle' | 'mapping' | 'localized' | 'navigating' | 'patrolling';

const USLAM_TOPICS = [
  RTC_TOPIC.USLAM_SERVER_LOG,
  RTC_TOPIC.USLAM_CLOUD_WORLD,
  RTC_TOPIC.USLAM_ODOM,
  RTC_TOPIC.USLAM_CLOUD_MAP,
  RTC_TOPIC.USLAM_LOC_ODOM,
  RTC_TOPIC.USLAM_LOC_CLOUD,
  RTC_TOPIC.USLAM_NAV_PATH,
  RTC_TOPIC.USLAM_GRID_MAP,
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

  constructor(
    parent: HTMLElement,
    onBack: () => void,
    onPublish: (topic: string, data: unknown) => void,
    onSubscribe: (topic: string) => void,
    onUnsubscribe: (topic: string) => void,
  ) {
    this.onBack = onBack;
    this.publish = onPublish;
    this.subscribe = onSubscribe;
    this.unsubscribe = onUnsubscribe;

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
    });

    // Subscribe to USLAM topics
    for (const topic of USLAM_TOPICS) {
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
        this.accumulatedPositions = [];
        this.cloudLogCount = 0;
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
          const b64 = btoa(id);
          this.sendCmd(`common/set_map_id/${b64}`);
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

    // Navigation section
    sidebar.appendChild(this.buildSection('Navigation', (body) => {
      body.appendChild(this.clickModeBtn('Set Goal', 'goal'));
      body.appendChild(this.btn('Start Navigation', '', () => {
        this.sendCmd('navigation/start');
        this.setState('navigating');
      }));
      body.appendChild(this.btn('Stop Navigation', '', () => {
        this.sendCmd('navigation/stop');
        this.setState('idle');
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
        this.sendCmd(`localization/set_initial_pose/${x.toFixed(3)}/${y.toFixed(3)}/${yaw.toFixed(3)}`);
        this.addLog(`Initial pose set: (${x.toFixed(2)}, ${y.toFixed(2)})`);
        // Deactivate click mode after setting
        this.activeClickBtn?.classList.remove('active');
        this.activeClickBtn = null;
        this.slamScene?.setClickMode('none');
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

  handleTopicMessage(topic: string, data: unknown): void {
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
        this.handleCloudWorld(data);
        break;
      case RTC_TOPIC.USLAM_NAV_PATH:
        this.handleNavPath(data);
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
    if (msg.includes('localization') && msg.includes('succeed')) this.setState('localized');
    if (msg.includes('REACHED')) this.setState('localized');
    if (msg.includes('Joystick') && msg.includes('stopped')) this.setState('idle');

    // Map ID response — populate the input field
    if (msg.includes('get_map_id') || msg.includes('map_id')) {
      const input = this.container.querySelector('#map-id-input') as HTMLInputElement;
      if (input) {
        // Try to extract map ID from the message
        try {
          const decoded = atob(msg.split('/').pop() || '');
          if (decoded) input.value = decoded;
        } catch {
          // Not base64, show raw
        }
      }
    }
  }

  private cloudLogCount = 0;
  private accumulatedPositions: number[] = [];
  private maxAccumulatedPoints = 500000; // 500k points max
  private accUpdateTimer = 0;

  private handleCloudWorld(data: unknown): void {
    if (!this.slamScene) return;

    // Extract binary data from the message
    let buffer: ArrayBuffer | null = null;

    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      // cloud_world_ds format: {header, is_dense, xmin..zmax, data: ArrayBuffer}
      if (d.data instanceof ArrayBuffer) {
        buffer = d.data;
      }
    }

    if (!buffer || buffer.byteLength < 12) return;

    const positions = new Float32Array(buffer);
    if (positions.length < 3) return;

    if (this.cloudLogCount < 3) {
      console.log(`[slam] Point cloud: ${positions.length / 3} points, accumulated: ${this.accumulatedPositions.length / 3}`);
      this.cloudLogCount++;
    }

    // Show current scan as green laser points
    this.slamScene.updateLaserCloud(positions);

    // Accumulate into the filtered (white) map
    for (let i = 0; i < positions.length; i++) {
      this.accumulatedPositions.push(positions[i]);
    }

    // Cap accumulated points to avoid memory issues
    if (this.accumulatedPositions.length > this.maxAccumulatedPoints * 3) {
      // Keep the most recent half
      this.accumulatedPositions = this.accumulatedPositions.slice(
        this.accumulatedPositions.length - this.maxAccumulatedPoints * 3,
      );
    }

    // Throttle accumulated map geometry rebuild to max every 500ms
    if (!this.accUpdateTimer) {
      this.accUpdateTimer = window.setTimeout(() => {
        this.accUpdateTimer = 0;
        this.slamScene?.updatePointCloud(new Float32Array(this.accumulatedPositions));
      }, 500);
    }
  }

  private odomLogCount = 0;

  private handleOdom(data: unknown): void {
    if (!this.slamScene) return;

    if (this.odomLogCount < 3) {
      console.log('[slam] Odom data:', JSON.stringify(data).slice(0, 300));
      this.odomLogCount++;
    }

    const d = data as {
      pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } };
      position?: { x: number; y: number; z: number };
      orientation?: { x: number; y: number; z: number; w: number };
    };

    const pos = d.pose?.position ?? d.position;
    const ori = d.pose?.orientation ?? d.orientation;
    if (!pos) return;

    // Extract yaw from quaternion
    let yaw = 0;
    if (ori) {
      // yaw from quaternion: atan2(2(wz + xy), 1 - 2(yy + zz))
      yaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z));
    }

    this.slamScene.updateRobotPose(pos, yaw);
    this.slamScene.addTracePoint(pos.x, pos.y, pos.z);
  }

  private handleNavPath(data: unknown): void {
    if (!this.slamScene) return;
    if (data instanceof ArrayBuffer) {
      this.slamScene.updateNavPath(new Float32Array(data));
    } else if (Array.isArray(data)) {
      // Array of {x, y, z} points
      const positions = new Float32Array(data.length * 3);
      data.forEach((p: { x: number; y: number; z?: number }, i: number) => {
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z ?? 0;
      });
      this.slamScene.updateNavPath(positions);
    }
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

  // ── Cleanup ──

  private cleanup(): void {
    for (const topic of USLAM_TOPICS) {
      this.unsubscribe(topic);
    }
  }

  destroy(): void {
    this.cleanup();
    this.slamScene?.destroy();
    this.slamScene = null;
  }
}

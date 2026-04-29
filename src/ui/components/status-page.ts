import { cloudApi, type RobotFamily } from '../../api/unitree-cloud';

export interface SystemInfo {
  /** Connection mode (STA-L, STA-T, AP, ...). */
  mode?: string;
  /** Robot IP, when connected via Local. */
  ip?: string;
  /** Cloud-bound serial number, when connected via Remote. */
  serialNumber?: string;
  /** Firmware-reported hardware version. Optional — populated by a
   *  bashrunner request (BaseRunner.GET_HARDWARE_VERSION) on G1; not
   *  yet implemented in this client. */
  hardwareVersion?: string;
  /** Firmware-reported software version (BaseRunner.GET_SOFTWARE_VERSION). */
  softwareVersion?: string;
}

export interface RobotStatus {
  batteryPercent: number;
  batteryCurrent: number;
  batteryVoltage: number;       // Go2: voltage; G1: pack_voltage
  batteryCycles: number;
  batteryTemp: number;          // Go2 / fallback: temps[0]
  // G1-specific bms_state fields. All optional so Go2 stays unaffected.
  batteryTemps?: number[];      // bms_state.temps — array of cell/MOS/RES temps
  batteryBatVoltage?: number;   // bms_state.bat_voltage — single-cell pack voltage
  batteryPackVoltage?: number;  // bms_state.pack_voltage — total pack voltage
  motorStates: Array<{
    q: number; dq: number; tau: number; temp: number; lost: number;
    /** G1 extras: temperature[0]=casing, temperature[1]=winding. */
    temperature?: number[];
    /** G1 extras: reserve[0]=accumulated loss, reserve[1]=comm quality raw,
     *  reserve[2]=error code (combined with motorstate). */
    reserve?: number[];
    /** G1 extras: motor state / error indicator. */
    motorstate?: number;
  }>;
  networkType: string;
  footForce: number[];
  imuTemp: number;
  // G1 ships two IMUs in rt/lf/lowstate_doubleimu: torso ("Body") and
  // pelvis ("Crotch"). Both optional so Go2's single-IMU shape is unaffected.
  bodyImu?: { rpy: [number, number, number]; temp: number };
  crotchImu?: { rpy: [number, number, number]; temp: number };
  mode: number;
  gaitType: number;
  position: number[];
  velocity: number[];
  firmwareVersion: string;
  // Filled from the bashrunner correlated-response handler
  // (get_hardware_version.sh / get_software_version.sh / get_ip_address.sh).
  hardwareVersion?: string;
  softwareVersion?: string;
  ipAddress?: string;
  motionMode: string;
  lidarState: string;
  selfTestResults: string[];
}

// Motor name layouts. The Go2 quadruped publishes 12 joints; the G1
// humanoid publishes 29 (12 legs + 3 waist + 14 arms in the lowstate
// motorStates array, matching the joint order of g1_29dof.urdf).
// If a future firmware exposes more motors than we have names for, the
// fallback "M<N>" label keeps the row legible.
const MOTOR_NAMES_GO2 = [
  'FR Hip', 'FR Thigh', 'FR Calf',
  'FL Hip', 'FL Thigh', 'FL Calf',
  'RR Hip', 'RR Thigh', 'RR Calf',
  'RL Hip', 'RL Thigh', 'RL Calf',
];
const MOTOR_NAMES_G1 = [
  'L Hip P', 'L Hip R', 'L Hip Y', 'L Knee', 'L Ank P', 'L Ank R',
  'R Hip P', 'R Hip R', 'R Hip Y', 'R Knee', 'R Ank P', 'R Ank R',
  'Waist Y', 'Waist R', 'Waist P',
  'L Sho P', 'L Sho R', 'L Sho Y', 'L Elbow', 'L Wri R', 'L Wri P', 'L Wri Y',
  'R Sho P', 'R Sho R', 'R Sho Y', 'R Elbow', 'R Wri R', 'R Wri P', 'R Wri Y',
];
function motorNamesFor(family: RobotFamily): string[] {
  return family === 'G1' ? MOTOR_NAMES_G1 : MOTOR_NAMES_GO2;
}
function motorName(family: RobotFamily, idx: number): string {
  return motorNamesFor(family)[idx] ?? `M${String(idx).padStart(2, '0')}`;
}

// G1 motor visual layout — front-view, viewer's left = robot's right.
// align='left' grows to the right of (x,y), 'right' to the left, 'center'
// is symmetric. y is in the same 320×520 viewBox as the SVG figure.
const G1_MOTOR_LAYOUT: Array<{ idx: number; name: string; x: number; y: number; align: 'left' | 'right' | 'center' }> = [
  // Left leg (robot's left, viewer's right) — motors 0–5
  { idx: 0,  name: 'L Hip P',  x: 215, y: 270, align: 'left' },
  { idx: 1,  name: 'L Hip R',  x: 215, y: 295, align: 'left' },
  { idx: 2,  name: 'L Hip Y',  x: 215, y: 320, align: 'left' },
  { idx: 3,  name: 'L Knee',   x: 215, y: 372, align: 'left' },
  { idx: 4,  name: 'L Ank P',  x: 215, y: 460, align: 'left' },
  { idx: 5,  name: 'L Ank R',  x: 215, y: 485, align: 'left' },
  // Right leg — motors 6–11
  { idx: 6,  name: 'R Hip P',  x: 105, y: 270, align: 'right' },
  { idx: 7,  name: 'R Hip R',  x: 105, y: 295, align: 'right' },
  { idx: 8,  name: 'R Hip Y',  x: 105, y: 320, align: 'right' },
  { idx: 9,  name: 'R Knee',   x: 105, y: 372, align: 'right' },
  { idx: 10, name: 'R Ank P',  x: 105, y: 460, align: 'right' },
  { idx: 11, name: 'R Ank R',  x: 105, y: 485, align: 'right' },
  // Waist — motors 12–14 (center column above the pelvis bar)
  { idx: 12, name: 'Waist Y',  x: 250, y: 158, align: 'left' },
  { idx: 13, name: 'Waist R',  x: 250, y: 185, align: 'left' },
  { idx: 14, name: 'Waist P',  x: 250, y: 212, align: 'left' },
  // Left arm — motors 15–21
  { idx: 15, name: 'L Sho P',  x: 268, y: 90,  align: 'left' },
  { idx: 16, name: 'L Sho R',  x: 268, y: 115, align: 'left' },
  { idx: 17, name: 'L Sho Y',  x: 268, y: 140, align: 'left' },
  { idx: 18, name: 'L Elbow',  x: 268, y: 200, align: 'left' },
  { idx: 19, name: 'L Wri R',  x: 268, y: 270, align: 'left' },
  { idx: 20, name: 'L Wri P',  x: 268, y: 295, align: 'left' },
  { idx: 21, name: 'L Wri Y',  x: 268, y: 320, align: 'left' },
  // Right arm — motors 22–28
  { idx: 22, name: 'R Sho P',  x: 52, y: 90,  align: 'right' },
  { idx: 23, name: 'R Sho R',  x: 52, y: 115, align: 'right' },
  { idx: 24, name: 'R Sho Y',  x: 52, y: 140, align: 'right' },
  { idx: 25, name: 'R Elbow',  x: 52, y: 200, align: 'right' },
  { idx: 26, name: 'R Wri R',  x: 52, y: 270, align: 'right' },
  { idx: 27, name: 'R Wri P',  x: 52, y: 295, align: 'right' },
  { idx: 28, name: 'R Wri Y',  x: 52, y: 320, align: 'right' },
];

/** Render a per-motor metric value to a short label. Mirrors the
 *  switch in BaseInfoViewModel.kt:415. */
function formatG1MotorMetric(m: RobotStatus['motorStates'][number], metricIdx: number): string {
  switch (metricIdx) {
    case 0: { // Comm Quality (reserve[1] * 100 / 500, clamped 0–100)
      const r1 = m.reserve?.[1];
      if (typeof r1 !== 'number') return '—';
      const pct = Math.max(0, Math.min(100, Math.round((r1 * 100) / 500)));
      return `${pct}%`;
    }
    case 1: { // Accumulated Loss
      const r0 = m.reserve?.[0];
      return typeof r0 === 'number' ? String(r0) : '—';
    }
    case 2: { // Position (rad → deg)
      return `${(m.q * 180 / Math.PI).toFixed(1)}°`;
    }
    case 3: { // Casing temp = temperature[0]
      const t = m.temperature?.[0] ?? m.temp;
      return `${Math.round(t)}°C`;
    }
    case 4: { // Winding temp = temperature[1]
      const t = m.temperature?.[1];
      return typeof t === 'number' ? `${Math.round(t)}°C` : '—';
    }
    case 5: { // Errors — non-zero motorstate or reserve[2] flags
      const ms = m.motorstate ?? 0;
      const r2 = m.reserve?.[2] ?? 0;
      return ms === 0 && r2 === 0 ? 'OK' : `e${ms}/${r2}`;
    }
    default:
      return '—';
  }
}

const MODE_NAMES: Record<number, string> = {
  0: 'Idle', 1: 'Balancing', 2: 'Walking', 3: 'Running',
  5: 'Stair Climbing', 6: 'Standing', 7: 'Sitting', 9: 'Damping',
};

export class StatusPage {
  private container: HTMLElement;
  private vals: Map<string, HTMLElement> = new Map();
  private motorRows: HTMLElement[] = [];
  private motorRowsParent: HTMLElement | null = null;
  private footForceRow: HTMLElement | null = null;
  private bodyImuSection: HTMLElement | null = null;
  private crotchImuSection: HTMLElement | null = null;
  private system: SystemInfo = {};
  private lidarBody: HTMLElement | null = null;
  private built = false;
  private updateTimer = 0;
  private pendingState: RobotStatus | null = null;

  constructor(parent: HTMLElement, initialState: RobotStatus, onBack: () => void, system: SystemInfo = {}) {
    this.system = system;
    this.container = document.createElement('div');
    this.container.className = 'status-page';

    // Header
    const header = document.createElement('div');
    header.className = 'page-header';
    const backBtn = document.createElement('button');
    backBtn.className = 'page-back-btn';
    backBtn.innerHTML = `<img src="/sprites/nav-bar-left-icon.png" alt="Back" />`;
    backBtn.addEventListener('click', onBack);
    header.appendChild(backBtn);
    const title = document.createElement('h2');
    title.textContent = 'Robot Status';
    header.appendChild(title);
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.className = 'page-content';
    this.buildSections(content);
    this.container.appendChild(content);
    parent.appendChild(this.container);

    this.built = true;
    this.applyState(initialState);
  }

  /** Throttled update — max ~4 updates/sec to prevent flicker. */
  update(state: RobotStatus): void {
    this.pendingState = state;
    if (this.updateTimer) return;
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      if (this.pendingState) {
        this.applyState(this.pendingState);
        this.pendingState = null;
      }
    }, 250);
  }

  private applyState(s: RobotStatus): void {
    if (!this.built) return;

    // System Info — values arriving via bashrunner (s.hardwareVersion /
    // s.softwareVersion / s.ipAddress) override the connection-config
    // seeds when present.
    this.setVal('sys-family', cloudApi.family);
    this.setVal('sys-mode',   this.system.mode || '—');
    this.setVal('sys-ip',     s.ipAddress || this.system.ip || '—');
    this.setVal('sys-sn',     this.system.serialNumber || '—');
    this.setVal('sys-hw',     s.hardwareVersion || this.system.hardwareVersion || '—');
    this.setVal('sys-sw',     s.softwareVersion || this.system.softwareVersion || '—');

    // Firmware
    this.setVal('fw-mode', s.motionMode || 'Unknown');

    // Battery
    const batColor = s.batteryPercent <= 33 ? '#FF3D3D' : s.batteryPercent <= 66 ? '#FCD335' : '#42CF55';
    this.setVal('bat-pct', `${s.batteryPercent}%`, batColor);
    const fill = this.vals.get('bat-fill');
    if (fill) { fill.style.width = `${s.batteryPercent}%`; fill.style.background = batColor; }
    this.setVal('bat-voltage', `${(s.batteryVoltage / 1000).toFixed(1)} V`);
    this.setVal('bat-current', `${s.batteryCurrent} mA`);
    this.setVal('bat-temp', `${s.batteryTemp}°C`);
    this.setVal('bat-cycles', `${s.batteryCycles}`);
    // G1-only extended fields (no-op when the row wasn't built)
    if (s.batteryPackVoltage !== undefined) {
      this.setVal('bat-pack-voltage', `${(s.batteryPackVoltage / 1000).toFixed(2)} V`);
    }
    if (s.batteryBatVoltage !== undefined) {
      this.setVal('bat-bat-voltage', `${(s.batteryBatVoltage / 1000).toFixed(2)} V`);
    }
    if (s.batteryTemps) {
      // Per the G1 BatteryDataViewmodel.kt index map: temps[0]=MOS,
      // temps[2]=BAT1, temps[3]=RES, temps[1] not surfaced separately.
      const labels = ['MOS', 'temp 2', 'BAT1', 'RES'];
      labels.forEach((lbl, i) => {
        const v = s.batteryTemps?.[i];
        if (v !== undefined) this.setVal(`bat-temp-${i}`, `${v}°C`);
      });
    }

    // Motors
    this.updateMotors(s);

    // IMU
    const modeName = MODE_NAMES[s.mode] || `Mode ${s.mode}`;
    this.setVal('imu-mode', modeName);
    this.setVal('imu-gait', `${s.gaitType}`);
    this.setVal('imu-temp', `${s.imuTemp.toFixed(1)}°C`);
    this.setVal('imu-pos', s.position.map((v) => v.toFixed(2)).join(', '));
    this.setVal('imu-vel', s.velocity.map((v) => v.toFixed(2)).join(', '));

    // Dual IMU on G1 (Body / Crotch). The rows are only built for G1, so
    // setVal is a no-op on Go2.
    const fmtRpy = (rpy: [number, number, number]): string =>
      `R ${rpy[0].toFixed(2)}, P ${rpy[1].toFixed(2)}, Y ${rpy[2].toFixed(2)}`;
    if (s.bodyImu) {
      if (this.bodyImuSection) this.bodyImuSection.style.display = '';
      this.setVal('imu-body-rpy',  fmtRpy(s.bodyImu.rpy));
      this.setVal('imu-body-temp', `${s.bodyImu.temp.toFixed(1)}°C`);
    }
    if (s.crotchImu) {
      if (this.crotchImuSection) this.crotchImuSection.style.display = '';
      this.setVal('imu-crotch-rpy',  fmtRpy(s.crotchImu.rpy));
      this.setVal('imu-crotch-temp', `${s.crotchImu.temp.toFixed(1)}°C`);
    }

    // LiDAR
    this.updateLidar(s);

    // Network
    this.setVal('net-type', s.networkType || 'Unknown');
  }

  private setVal(id: string, text: string, color?: string): void {
    const el = this.vals.get(id);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (color) el.style.color = color;
  }

  private buildSections(content: HTMLElement): void {
    // System Info — surfaces what we know from the connection config
    // (family, mode, IP, SN) plus the bashrunner-fetched hardware /
    // software / IP fields once they land.
    const systemRows: HTMLElement[] = [
      this.row('Family', 'sys-family'),
      this.row('Mode', 'sys-mode'),
      this.row('IP Address', 'sys-ip'),
    ];
    // SN only meaningful in Remote mode where it comes from the cloud
    // device binding. Skip the row in Local mode to avoid a permanent '-'.
    if (this.system.serialNumber) {
      systemRows.push(this.row('Serial Number', 'sys-sn'));
    }
    systemRows.push(
      this.row('Hardware Version', 'sys-hw'),
      this.row('Software Version', 'sys-sw'),
    );
    content.appendChild(this.buildSection('System', systemRows));

    // Motion Mode is its own section (Software Version moved into System).
    content.appendChild(this.buildSection('Firmware', [
      this.row('Motion Mode', 'fw-mode'),
    ]));

    // Battery
    const batPctRow = this.row('Charge', 'bat-pct');
    const barTrack = document.createElement('div');
    barTrack.className = 'status-bar-track';
    const barFill = document.createElement('div');
    barFill.className = 'status-bar-fill';
    barTrack.appendChild(barFill);
    this.vals.set('bat-fill', barFill);

    const batteryRows: HTMLElement[] = [
      batPctRow, barTrack,
      this.row('Voltage', 'bat-voltage'),
      this.row('Current', 'bat-current'),
      this.row('Temperature', 'bat-temp'),
      this.row('Charge Cycles', 'bat-cycles'),
    ];
    // G1 BMS exposes more granular voltage + temperature rails. Build the
    // extra rows up front; setVal is a no-op until data lands so they
    // show '-' on a fresh G1 connection until the first bmsstate frame.
    // Field/index map mirrors com/unitree/g1/ui/battery/BatteryDataViewmodel.kt.
    if (cloudApi.family === 'G1') {
      batteryRows.push(
        this.row('Pack Voltage', 'bat-pack-voltage'),
        this.row('Cell Voltage', 'bat-bat-voltage'),
        this.row('MOS Temp',  'bat-temp-0'),
        this.row('BAT1 Temp', 'bat-temp-2'),
        this.row('RES Temp',  'bat-temp-3'),
      );
    }
    content.appendChild(this.buildSection('Battery', batteryRows));

    // Motors. G1 swaps the row table for an apk-style humanoid figure
    // with 29 callouts driven by a 6-tab metric switcher (Comm Quality /
    // Acc Loss / Position / Casing °C / Winding °C / Errors). Go2 keeps
    // the dense row table that's been there since launch.
    const family = cloudApi.family;
    const motorBody = document.createElement('div');
    motorBody.className = 'status-section-body';

    if (family === 'G1') {
      this.buildG1MotorPanel(motorBody);
    } else {
      const motorHeader = document.createElement('div');
      motorHeader.className = 'status-motor-header';
      for (const label of ['Motor', 'Pos', 'Vel', 'Torque', 'Temp', 'Lost']) {
        const s = document.createElement('span');
        s.textContent = label;
        motorHeader.appendChild(s);
      }
      motorBody.appendChild(motorHeader);
      for (let i = 0; i < 12; i++) {
        const r = this.buildMotorRow(family, i);
        this.motorRows.push(r);
        motorBody.appendChild(r);
      }
      this.motorRowsParent = motorBody;
    }

    const summary = document.createElement('div');
    summary.className = 'status-summary';
    summary.appendChild(this.row('Communication Quality', 'motor-quality'));
    summary.appendChild(this.row('Max Motor Temp', 'motor-max-temp'));
    motorBody.appendChild(summary);

    // Foot-force is a quadruped concept (FR/FL/RR/RL contact). G1 publishes
    // empty footForce arrays and has dexterous hands instead — skip the
    // section entirely on humanoid families.
    if (family !== 'G1') {
      const footSummary = document.createElement('div');
      footSummary.className = 'status-summary';
      const footLabel = document.createElement('div');
      footLabel.className = 'status-row';
      const footLabelText = document.createElement('span');
      footLabelText.className = 'status-label';
      footLabelText.textContent = 'Foot Force';
      footLabel.appendChild(footLabelText);
      footSummary.appendChild(footLabel);
      const footHeader = document.createElement('div');
      footHeader.className = 'status-motor-header';
      footHeader.style.gridTemplateColumns = 'repeat(4,1fr)';
      for (const label of ['FR', 'FL', 'RR', 'RL']) {
        const s = document.createElement('span');
        s.textContent = label;
        footHeader.appendChild(s);
      }
      footSummary.appendChild(footHeader);
      this.footForceRow = document.createElement('div');
      this.footForceRow.className = 'status-motor-row';
      this.footForceRow.style.gridTemplateColumns = 'repeat(4,1fr)';
      for (let c = 0; c < 4; c++) {
        const cell = document.createElement('span');
        cell.textContent = '-';
        this.footForceRow.appendChild(cell);
      }
      footSummary.appendChild(this.footForceRow);
      motorBody.appendChild(footSummary);
    }

    content.appendChild(this.buildSection('Motor Data', [], motorBody));

    // IMU
    const imuRows: HTMLElement[] = [
      this.row('Robot Mode', 'imu-mode'),
      this.row('Gait Type', 'imu-gait'),
      this.row('IMU Temperature', 'imu-temp'),
      this.row('Position (x, y, z)', 'imu-pos'),
      this.row('Velocity (x, y, z)', 'imu-vel'),
    ];
    content.appendChild(this.buildSection('IMU & Position', imuRows));

    // G1 ships two IMUs. Surface them in their own section so the legacy
    // 'IMU & Position' block stays untouched for Go2. Source:
    // rt/lf/lowstate_doubleimu (parsed in app.ts handleDoubleImu).
    if (family === 'G1') {
      this.bodyImuSection = this.buildSection('Body IMU (Torso)', [
        this.row('Roll / Pitch / Yaw', 'imu-body-rpy'),
        this.row('Temperature', 'imu-body-temp'),
      ]);
      this.crotchImuSection = this.buildSection('Crotch IMU (Pelvis)', [
        this.row('Roll / Pitch / Yaw', 'imu-crotch-rpy'),
        this.row('Temperature', 'imu-crotch-temp'),
      ]);
      // Hidden until the first rt/lf/lowstate_doubleimu frame lands —
      // user may have selected the G1 family pill but be connected to
      // a quadruped that doesn't publish that topic.
      this.bodyImuSection.style.display = 'none';
      this.crotchImuSection.style.display = 'none';
      content.appendChild(this.bodyImuSection);
      content.appendChild(this.crotchImuSection);
    }

    // LiDAR — Go2 only. G1's webview doesn't surface LiDAR/SLAM UI, and
    // its lowstate doesn't carry a lidarState payload, so the section
    // would just sit on "Waiting for LiDAR state..." indefinitely.
    if (family !== 'G1') {
      this.lidarBody = document.createElement('div');
      this.lidarBody.className = 'status-section-body';
      const lidarWait = document.createElement('div');
      lidarWait.className = 'status-row';
      const lidarWaitLabel = document.createElement('span');
      lidarWaitLabel.className = 'status-label';
      lidarWaitLabel.textContent = 'Waiting for LiDAR state...';
      lidarWait.appendChild(lidarWaitLabel);
      this.lidarBody.appendChild(lidarWait);
      content.appendChild(this.buildSection('LiDAR', [], this.lidarBody));
    }

    // Network
    content.appendChild(this.buildSection('Network', [
      this.row('Connection Type', 'net-type'),
    ]));
  }

  private buildSection(title: string, children: HTMLElement[], customBody?: HTMLElement): HTMLElement {
    const section = document.createElement('div');
    section.className = 'status-section';
    const heading = document.createElement('div');
    heading.className = 'status-section-title';
    heading.textContent = title;
    section.appendChild(heading);

    if (customBody) {
      section.appendChild(customBody);
    } else {
      const body = document.createElement('div');
      body.className = 'status-section-body';
      for (const child of children) body.appendChild(child);
      section.appendChild(body);
    }
    return section;
  }

  private row(label: string, valId: string): HTMLElement {
    const r = document.createElement('div');
    r.className = 'status-row';
    const lbl = document.createElement('span');
    lbl.className = 'status-label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className = 'status-value';
    val.textContent = '-';
    r.appendChild(lbl);
    r.appendChild(val);
    this.vals.set(valId, val);
    return r;
  }

  // ── G1 humanoid motor panel ─────────────────────────────────────────
  // Modeled after BaseInfoActivity.kt. Six metrics map to motor_state
  // fields per BaseInfoViewModel.kt:415:
  //   0 Comm Quality  : reserve[1] * 100 / 500 clamped to [0,100], '%'
  //   1 Acc Loss      : reserve[0] (raw count)
  //   2 Location      : toDegrees(q), 2dp, '°'
  //   3 Casing  Temp  : temperature[0] '°C'
  //   4 Winding Temp  : temperature[1] '°C'
  //   5 Errors        : motorstate + reserve[2] flags
  private g1MetricIdx = 0;
  private g1Callouts: Array<{ el: HTMLElement; idx: number }> = [];
  private g1MetricTabs: HTMLButtonElement[] = [];
  private lastMotorStates: RobotStatus['motorStates'] = [];

  private buildG1MotorPanel(parent: HTMLElement): void {
    // Metric switcher tabs
    const tabRow = document.createElement('div');
    tabRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:4px 0 10px;';
    const labels = ['Comm Quality', 'Acc Loss', 'Position', 'Casing °C', 'Winding °C', 'Errors'];
    labels.forEach((lbl, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = lbl;
      btn.dataset.metricId = String(i);
      btn.style.cssText = `flex:1;min-width:78px;padding:5px 6px;font-size:10px;font-weight:600;letter-spacing:0.4px;border:1px solid #2a2d35;border-radius:5px;cursor:pointer;background:${i === this.g1MetricIdx ? '#4fc3f7' : 'transparent'};color:${i === this.g1MetricIdx ? '#000' : '#888'};transition:background 0.12s,color 0.12s;`;
      btn.addEventListener('click', () => {
        this.g1MetricIdx = i;
        for (const t of this.g1MetricTabs) {
          const active = t.dataset.metricId === String(i);
          t.style.background = active ? '#4fc3f7' : 'transparent';
          t.style.color = active ? '#000' : '#888';
        }
        this.updateG1MotorPanel(this.lastMotorStates);
      });
      this.g1MetricTabs.push(btn);
      tabRow.appendChild(btn);
    });
    parent.appendChild(tabRow);

    // Humanoid SVG figure + 29 absolutely-positioned callouts.
    // viewBox is 320 × 520; the container is the same so callouts can
    // share the same coordinate space.
    const figure = document.createElement('div');
    figure.style.cssText = 'position:relative;width:320px;height:520px;margin:0 auto;';
    figure.innerHTML = `
      <svg width="320" height="520" viewBox="0 0 320 520" style="position:absolute;inset:0;" stroke="#5a6170" stroke-width="2" fill="none" stroke-linecap="round">
        <circle cx="160" cy="50"  r="22" fill="#1a1d23" />
        <line x1="160" y1="72" x2="160" y2="100" />
        <line x1="115" y1="100" x2="205" y2="100" />
        <line x1="160" y1="100" x2="160" y2="260" />
        <line x1="120" y1="260" x2="200" y2="260" />
        <!-- arms -->
        <line x1="205" y1="100" x2="225" y2="200" />
        <line x1="225" y1="200" x2="245" y2="290" />
        <line x1="115" y1="100" x2="95"  y2="200" />
        <line x1="95"  y1="200" x2="75"  y2="290" />
        <!-- legs -->
        <line x1="180" y1="260" x2="180" y2="370" />
        <line x1="180" y1="370" x2="180" y2="475" />
        <line x1="140" y1="260" x2="140" y2="370" />
        <line x1="140" y1="370" x2="140" y2="475" />
        <!-- joint dots -->
        ${[[160,100],[205,100],[115,100],[225,200],[95,200],[245,290],[75,290],[160,230],[160,260],[180,260],[140,260],[180,370],[140,370],[180,475],[140,475]].map(([cx,cy]) => `<circle cx="${cx}" cy="${cy}" r="4" fill="#5a6170" stroke="none" />`).join('')}
      </svg>
    `;

    const callouts = G1_MOTOR_LAYOUT;
    this.g1Callouts = [];
    for (const c of callouts) {
      const box = document.createElement('div');
      const w = 56;
      box.style.cssText = `position:absolute;width:${w}px;text-align:${c.align};font-size:10px;line-height:1.25;font-family:monospace;color:#e0e0e0;pointer-events:none;`;
      // Anchor: align='left' means box extends right of x; 'right' extends left of x; 'center' centered on x.
      const left = c.align === 'left' ? c.x : c.align === 'right' ? c.x - w : c.x - w / 2;
      box.style.left = `${left}px`;
      box.style.top  = `${c.y - 6}px`;
      box.innerHTML = `<div style="color:#666;font-weight:600;font-size:9px;">${this.esc(c.name)}</div><div data-motor-val>—</div>`;
      figure.appendChild(box);
      this.g1Callouts.push({ el: box, idx: c.idx });
    }
    parent.appendChild(figure);
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  private updateG1MotorPanel(states: RobotStatus['motorStates']): void {
    if (this.g1Callouts.length === 0) return;
    for (const { el, idx } of this.g1Callouts) {
      const m = states[idx];
      const valEl = el.querySelector('[data-motor-val]') as HTMLElement | null;
      if (!valEl) continue;
      if (!m) { valEl.textContent = '—'; continue; }
      valEl.textContent = formatG1MotorMetric(m, this.g1MetricIdx);
    }
  }

  private buildMotorRow(family: RobotFamily, idx: number): HTMLElement {
    const r = document.createElement('div');
    r.className = 'status-motor-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'motor-name';
    nameSpan.textContent = motorName(family, idx);
    r.appendChild(nameSpan);
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement('span');
      cell.textContent = '-';
      r.appendChild(cell);
    }
    return r;
  }

  private ensureMotorRows(count: number): void {
    if (!this.motorRowsParent || count <= this.motorRows.length) return;
    const family = cloudApi.family;
    // Insert new rows just before the summary block (last child of the body)
    // so the summary stays at the bottom.
    const summaryAnchor = this.motorRowsParent.querySelector('.status-summary');
    for (let i = this.motorRows.length; i < count; i++) {
      const r = this.buildMotorRow(family, i);
      this.motorRows.push(r);
      if (summaryAnchor) this.motorRowsParent.insertBefore(r, summaryAnchor);
      else this.motorRowsParent.appendChild(r);
    }
  }

  private updateMotors(s: RobotStatus): void {
    if (s.motorStates.length === 0) return;

    // G1: update humanoid callouts. Summary (Comm Quality / Max Motor Temp)
    // is still computed from the same per-motor data below.
    this.lastMotorStates = s.motorStates;
    if (this.g1Callouts.length > 0) {
      this.updateG1MotorPanel(s.motorStates);
      let totalLost = 0;
      let maxTemp = 0;
      for (const m of s.motorStates) {
        totalLost += m.lost ?? 0;
        const t = m.temperature ? Math.max(...m.temperature) : m.temp;
        if (t > maxTemp) maxTemp = t;
      }
      this.setVal('motor-quality', totalLost === 0 ? 'Good' : `${totalLost} lost`,
        totalLost > 0 ? '#FF3D3D' : '#42CF55');
      this.setVal('motor-max-temp', `${maxTemp}°C`,
        maxTemp > 70 ? '#FF3D3D' : maxTemp > 50 ? '#FCD335' : '#42CF55');
      return;
    }

    this.ensureMotorRows(s.motorStates.length);

    let totalLost = 0;
    let maxTemp = 0;

    s.motorStates.forEach((m, i) => {
      const row = this.motorRows[i];
      if (!row) return;
      const cells = row.children;
      // cells: [name, pos, vel, torque, temp, lost]
      cells[1].textContent = (m.q ?? 0).toFixed(2);
      cells[2].textContent = (m.dq ?? 0).toFixed(1);
      cells[3].textContent = (m.tau ?? 0).toFixed(1);
      const temp = m.temp ?? 0;
      const tempColor = temp > 70 ? '#FF3D3D' : temp > 50 ? '#FCD335' : '#42CF55';
      (cells[4] as HTMLElement).textContent = `${temp}°`;
      (cells[4] as HTMLElement).style.color = tempColor;
      const lost = m.lost ?? 0;
      const lostColor = lost > 0 ? '#FF3D3D' : '#42CF55';
      (cells[5] as HTMLElement).textContent = `${lost}`;
      (cells[5] as HTMLElement).style.color = lostColor;
      totalLost += lost;
      if (temp > maxTemp) maxTemp = temp;
    });

    const qualColor = totalLost > 0 ? '#FF3D3D' : '#42CF55';
    this.setVal('motor-quality', totalLost === 0 ? 'Good' : `${totalLost} lost`, qualColor);
    const maxTempColor = maxTemp > 70 ? '#FF3D3D' : maxTemp > 50 ? '#FCD335' : '#42CF55';
    this.setVal('motor-max-temp', `${maxTemp}°C`, maxTempColor);

    if (s.footForce.length > 0 && this.footForceRow) {
      const cells = this.footForceRow.children;
      s.footForce.forEach((f, i) => {
        if (cells[i]) cells[i].textContent = `${f}`;
      });
    }
  }

  private lidarKeys: string[] = [];

  private updateLidar(s: RobotStatus): void {
    if (!this.lidarBody) return;
    if (!s.lidarState) return;

    try {
      const lidar = JSON.parse(s.lidarState) as Record<string, unknown>;
      const keys = Object.keys(lidar);

      // Only add new rows if keys changed — never remove/rebuild existing DOM
      if (keys.length !== this.lidarKeys.length || keys.some((k, i) => k !== this.lidarKeys[i])) {
        // Clear the "Waiting..." placeholder on first data
        if (this.lidarKeys.length === 0) {
          this.lidarBody.innerHTML = '';
        }
        // Add rows for any new keys
        for (const key of keys) {
          if (!this.vals.has(`lidar-${key}`)) {
            const r = this.row(this.formatKey(key), `lidar-${key}`);
            this.lidarBody.appendChild(r);
          }
        }
        this.lidarKeys = keys;
      }

      // Update values only
      for (const [key, value] of Object.entries(lidar)) {
        this.setVal(`lidar-${key}`, String(value));
      }
    } catch { /* ignore */ }
  }

  private formatKey(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

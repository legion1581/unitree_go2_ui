import { cloudApi, type RobotFamily } from '../../api/unitree-cloud';

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
  motorStates: Array<{ q: number; dq: number; tau: number; temp: number; lost: number }>;
  networkType: string;
  footForce: number[];
  imuTemp: number;
  mode: number;
  gaitType: number;
  position: number[];
  velocity: number[];
  firmwareVersion: string;
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
  private lidarBody: HTMLElement | null = null;
  private built = false;
  private updateTimer = 0;
  private pendingState: RobotStatus | null = null;

  constructor(parent: HTMLElement, initialState: RobotStatus, onBack: () => void) {
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

    // Firmware
    this.setVal('fw-version', s.firmwareVersion || 'Fetching...');
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
    // Firmware
    content.appendChild(this.buildSection('Firmware', [
      this.row('Package Version', 'fw-version'),
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

    // Motors — body becomes the live container so we can grow / shrink rows
    // when the incoming motorStates length doesn't match the family's expected
    // count (e.g. firmware exposes a 23-DOF G1 instead of 29).
    const motorBody = document.createElement('div');
    motorBody.className = 'status-section-body';

    const motorHeader = document.createElement('div');
    motorHeader.className = 'status-motor-header';
    for (const label of ['Motor', 'Pos', 'Vel', 'Torque', 'Temp', 'Lost']) {
      const s = document.createElement('span');
      s.textContent = label;
      motorHeader.appendChild(s);
    }
    motorBody.appendChild(motorHeader);

    const family = cloudApi.family;
    const initialCount = family === 'G1' ? 29 : 12;
    for (let i = 0; i < initialCount; i++) {
      const r = this.buildMotorRow(family, i);
      this.motorRows.push(r);
      motorBody.appendChild(r);
    }
    this.motorRowsParent = motorBody;

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
    content.appendChild(this.buildSection('IMU & Position', [
      this.row('Robot Mode', 'imu-mode'),
      this.row('Gait Type', 'imu-gait'),
      this.row('IMU Temperature', 'imu-temp'),
      this.row('Position (x, y, z)', 'imu-pos'),
      this.row('Velocity (x, y, z)', 'imu-vel'),
    ]));

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

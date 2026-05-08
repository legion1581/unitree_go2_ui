export interface GamepadInputState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  keys: number;
  id: string;
}

export type GamepadConnectionHandler = (connected: boolean, id: string) => void;

export class GamepadManager {
  private rafId: number | null = null;
  private polling = false;
  private scanning = false;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private gamepadIndex: number | null = null;
  private state: GamepadInputState | null = null;
  private onConnectionChange: GamepadConnectionHandler | null = null;
  private deadzoneValue = 0.08;
  private reportedConnected = false;

  constructor(onConnectionChange?: GamepadConnectionHandler) {
    this.onConnectionChange = onConnectionChange ?? null;
    window.addEventListener('gamepadconnected', this.handleConnect);
    window.addEventListener('gamepaddisconnected', this.handleDisconnect);

    // Some browsers (Chrome) don't fire gamepadconnected for pads already
    // plugged in at page load, or if the user hasn't interacted with the
    // controller yet. We scan immediately AND run a background interval.
    this.scanForGamepads();
    this.startBackgroundScan();
    window.addEventListener('focus', this.scanForGamepads);
  }

  destroy(): void {
    this.stop();
    this.stopBackgroundScan();
    window.removeEventListener('gamepadconnected', this.handleConnect);
    window.removeEventListener('gamepaddisconnected', this.handleDisconnect);
    window.removeEventListener('focus', this.scanForGamepads);
  }

  get currentState(): Readonly<GamepadInputState> | null {
    return this.state;
  }

  setDeadzone(value: number): void {
    this.deadzoneValue = Math.max(0, Math.min(1, value));
  }

  private startBackgroundScan(): void {
    if (this.scanInterval !== null) return;
    // Scan every 500ms for newly plugged controllers
    this.scanInterval = setInterval(() => this.scanForGamepads(), 500);
  }

  private stopBackgroundScan(): void {
    if (this.scanInterval !== null) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  private scanForGamepads = (): void => {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    let found: Gamepad | null = null;
    for (let i = 0; i < gps.length; i++) {
      const gp = gps[i];
      if (gp) {
        found = gp;
        break;
      }
    }

    if (found && this.gamepadIndex === null) {
      console.log('[gamepad] detected', found.id, 'index', found.index);
      this.attach(found);
    } else if (!found && this.gamepadIndex !== null) {
      // The previously tracked pad disappeared from getGamepads
      this.detach();
    }
  };

  private handleConnect = (e: GamepadEvent): void => {
    if (this.gamepadIndex === null) {
      this.attach(e.gamepad);
    }
  };

  private handleDisconnect = (e: GamepadEvent): void => {
    if (e.gamepad.index === this.gamepadIndex) {
      this.detach();
    }
  };

  private attach(gp: Gamepad): void {
    this.gamepadIndex = gp.index;
    this.reportedConnected = true;
    if (!this.polling) {
      this.polling = true;
      this.poll();
    }
    this.onConnectionChange?.(true, gp.id);
  }

  private detach(): void {
    this.gamepadIndex = null;
    this.state = null;
    this.polling = false;
    this.reportedConnected = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.onConnectionChange?.(false, '');
  }

  private stop(): void {
    this.polling = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private poll = (): void => {
    if (this.gamepadIndex === null) {
      this.polling = false;
      return;
    }

    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) {
      this.detach();
      return;
    }

    const lx = gp.axes.length > 0 ? this.applyDeadzone(gp.axes[0]) : 0;
    const ly = gp.axes.length > 1 ? this.applyDeadzone(-gp.axes[1]) : 0;
    const rx = gp.axes.length > 2 ? this.applyDeadzone(gp.axes[2]) : 0;
    const ry = gp.axes.length > 3 ? this.applyDeadzone(-gp.axes[3]) : 0;

    let keys = 0;
    const b = gp.buttons;
    if (b[5]?.pressed) keys |= 1 << 0;   // R1
    if (b[4]?.pressed) keys |= 1 << 1;   // L1
    if (b[9]?.pressed) keys |= 1 << 2;   // Start
    if (b[8]?.pressed) keys |= 1 << 3;   // Select
    if (b[7]?.pressed) keys |= 1 << 4;   // R2
    if (b[6]?.pressed) keys |= 1 << 5;   // L2
    if (b[10]?.pressed) keys |= 1 << 6;  // F1 (L3)
    if (b[11]?.pressed) keys |= 1 << 7;  // F2 (R3)
    if (b[0]?.pressed) keys |= 1 << 8;   // A
    if (b[1]?.pressed) keys |= 1 << 9;   // B
    if (b[2]?.pressed) keys |= 1 << 10;  // X
    if (b[3]?.pressed) keys |= 1 << 11;  // Y
    if (b[12]?.pressed) keys |= 1 << 12; // Up
    if (b[15]?.pressed) keys |= 1 << 13; // Right
    if (b[13]?.pressed) keys |= 1 << 14; // Down
    if (b[14]?.pressed) keys |= 1 << 15; // Left

    this.state = { lx, ly, rx, ry, keys, id: gp.id };
    this.rafId = requestAnimationFrame(this.poll);
  };

  private applyDeadzone(v: number): number {
    const dz = this.deadzoneValue;
    if (Math.abs(v) < dz) return 0;
    // Rescale so the range [dz, 1] maps linearly to [0, 1]
    return v > 0 ? (v - dz) / (1 - dz) : (v + dz) / (1 - dz);
  }
}

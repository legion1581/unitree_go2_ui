export interface JoystickOutput {
  x: number; // -1 to 1 (left/right)
  y: number; // -1 to 1 (down/up)
}

export type JoystickCallback = (output: JoystickOutput) => void;

export class Joystick {
  private box: HTMLElement;
  private knob: HTMLElement;
  private onChange: JoystickCallback;
  private onStop?: () => void;
  private active = false;
  private touchId: number | null = null;
  private centerX = 0;
  private centerY = 0;
  private maxDist = 0;

  constructor(
    parent: HTMLElement,
    onChange: JoystickCallback,
    onStop?: () => void,
  ) {
    this.onChange = onChange;
    this.onStop = onStop;

    this.box = document.createElement('div');
    this.box.className = 'joystick-box';

    // Background ring image
    const bg = document.createElement('img');
    bg.className = 'joystick-bg';
    bg.src = '/sprites/joystick_bg.png';
    bg.draggable = false;
    this.box.appendChild(bg);

    // Knob (thumb)
    this.knob = document.createElement('div');
    this.knob.className = 'joystick-knob';
    const knobImg = document.createElement('img');
    knobImg.src = '/sprites/joystick-active2.png';
    knobImg.draggable = false;
    this.knob.appendChild(knobImg);
    this.box.appendChild(this.knob);

    parent.appendChild(this.box);

    this.box.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.box.addEventListener('mousedown', (e) => this.onMouseStart(e));
    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('touchend', (e) => this.onTouchEnd(e));
    window.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
    window.addEventListener('mouseup', () => this.onMouseEnd());
  }

  private recalc(): void {
    const rect = this.box.getBoundingClientRect();
    this.centerX = rect.left + rect.width / 2;
    this.centerY = rect.top + rect.height / 2;
    this.maxDist = rect.width / 2 - 32; // knob is 64px, half = 32
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    if (this.active) return;
    const t = e.changedTouches[0];
    this.touchId = t.identifier;
    this.active = true;
    this.recalc();
    this.update(t.clientX, t.clientY);
  }

  private onMouseStart(e: MouseEvent): void {
    e.preventDefault();
    this.active = true;
    this.recalc();
    this.update(e.clientX, e.clientY);
  }

  private onTouchMove(e: TouchEvent): void {
    if (!this.active) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === this.touchId) {
        e.preventDefault();
        this.update(t.clientX, t.clientY);
        break;
      }
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.active || this.touchId !== null) return;
    this.update(e.clientX, e.clientY);
  }

  private onTouchEnd(e: TouchEvent): void {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this.touchId) {
        this.reset();
        break;
      }
    }
  }

  private onMouseEnd(): void {
    if (this.active && this.touchId === null) {
      this.reset();
    }
  }

  private update(cx: number, cy: number): void {
    let dx = cx - this.centerX;
    let dy = cy - this.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.maxDist) {
      dx = (dx / dist) * this.maxDist;
      dy = (dy / dist) * this.maxDist;
    }

    // Position knob relative to center (knob is already centered via CSS transform)
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    this.onChange({
      x: dx / this.maxDist,
      y: -dy / this.maxDist,
    });
  }

  private reset(): void {
    this.active = false;
    this.touchId = null;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.onChange({ x: 0, y: 0 });
    this.onStop?.();
  }

  setDisabled(disabled: boolean): void {
    this.box.classList.toggle('disable', disabled);
  }
}

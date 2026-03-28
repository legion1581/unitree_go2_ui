export type PipContent = 'camera' | 'voxel';

export class PipCamera {
  private container: HTMLElement;
  private videoEl: HTMLVideoElement;
  private overlay: HTMLElement;
  private noiseCanvas: HTMLCanvasElement;
  private noiseCtx: CanvasRenderingContext2D;
  private noiseAnimId = 0;
  private hasStream = false;
  private currentContent: PipContent = 'camera';

  // Mini 3D canvas placeholder (will be populated by scene)
  private miniCanvas: HTMLCanvasElement | null = null;

  // Drag state
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private offsetX = 0;
  private offsetY = 0;
  private hasMoved = false;

  // View swap callback
  private onTap: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'pip-camera';

    this.videoEl = document.createElement('video');
    this.videoEl.autoplay = true;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.container.appendChild(this.videoEl);

    // White noise canvas (shown when no video)
    this.noiseCanvas = document.createElement('canvas');
    this.noiseCanvas.className = 'pip-noise';
    this.noiseCanvas.width = 385;
    this.noiseCanvas.height = 260;
    this.noiseCtx = this.noiseCanvas.getContext('2d')!;
    this.container.appendChild(this.noiseCanvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'pip-overlay';
    this.overlay.textContent = 'No Video';
    this.container.appendChild(this.overlay);

    // Drag handlers
    this.container.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());

    parent.appendChild(this.container);

    // Start white noise animation
    this.startNoise();
  }

  setStream(stream: MediaStream): void {
    this.videoEl.srcObject = stream;
    this.hasStream = true;
    if (this.currentContent === 'camera') {
      this.overlay.style.display = 'none';
      this.noiseCanvas.style.display = 'none';
      this.videoEl.style.display = 'block';
      this.stopNoise();
    }
  }

  clear(): void {
    this.videoEl.srcObject = null;
    this.hasStream = false;
    if (this.currentContent === 'camera') {
      this.videoEl.style.display = 'none';
      this.overlay.style.display = '';
      this.noiseCanvas.style.display = 'block';
      this.startNoise();
    }
  }

  /** Show camera feed in PIP (voxel map is fullscreen) */
  showCamera(): void {
    this.currentContent = 'camera';
    this.hideMiniCanvas();
    if (this.hasStream) {
      this.videoEl.style.display = 'block';
      this.noiseCanvas.style.display = 'none';
      this.overlay.style.display = 'none';
      this.stopNoise();
    } else {
      this.videoEl.style.display = 'none';
      this.noiseCanvas.style.display = 'block';
      this.overlay.style.display = '';
      this.startNoise();
    }
    this.container.style.display = '';
  }

  /** Show voxel/3D scene in PIP (camera is fullscreen) */
  showVoxel(threeCanvas: HTMLCanvasElement): void {
    this.currentContent = 'voxel';
    this.videoEl.style.display = 'none';
    this.noiseCanvas.style.display = 'none';
    this.overlay.style.display = 'none';
    this.stopNoise();

    // Create or reuse mini canvas that mirrors the main 3D canvas
    if (!this.miniCanvas) {
      this.miniCanvas = document.createElement('canvas');
      this.miniCanvas.className = 'pip-mini-3d';
      this.container.appendChild(this.miniCanvas);
    }
    this.miniCanvas.style.display = 'block';

    // Copy the main 3D canvas content to the mini canvas at intervals
    this.startMiniCanvasMirror(threeCanvas);
    this.container.style.display = '';
  }

  private miniMirrorId = 0;

  private startMiniCanvasMirror(source: HTMLCanvasElement): void {
    this.stopMiniCanvasMirror();
    if (!this.miniCanvas) return;
    const ctx = this.miniCanvas.getContext('2d');
    if (!ctx) return;

    const mirror = () => {
      if (!this.miniCanvas || this.currentContent !== 'voxel') return;
      this.miniCanvas.width = this.container.clientWidth;
      this.miniCanvas.height = this.container.clientHeight;
      ctx.drawImage(source, 0, 0, this.miniCanvas.width, this.miniCanvas.height);
      this.miniMirrorId = requestAnimationFrame(mirror);
    };
    this.miniMirrorId = requestAnimationFrame(mirror);
  }

  private stopMiniCanvasMirror(): void {
    if (this.miniMirrorId) {
      cancelAnimationFrame(this.miniMirrorId);
      this.miniMirrorId = 0;
    }
  }

  private hideMiniCanvas(): void {
    this.stopMiniCanvasMirror();
    if (this.miniCanvas) this.miniCanvas.style.display = 'none';
  }

  /** Set callback for tap (no-drag click) to swap views. */
  setOnTap(fn: () => void): void {
    this.onTap = fn;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  // ── White noise rendering ──

  private startNoise(): void {
    if (this.noiseAnimId) return;
    const draw = () => {
      this.drawNoise();
      this.noiseAnimId = requestAnimationFrame(draw);
    };
    this.noiseAnimId = requestAnimationFrame(draw);
  }

  private stopNoise(): void {
    if (this.noiseAnimId) {
      cancelAnimationFrame(this.noiseAnimId);
      this.noiseAnimId = 0;
    }
  }

  private drawNoise(): void {
    const w = this.noiseCanvas.width;
    const h = this.noiseCanvas.height;
    const imageData = this.noiseCtx.createImageData(w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    this.noiseCtx.putImageData(imageData, 0, 0);
  }

  // ── Drag handlers ──

  private onPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.hasMoved = false;
    this.dragStartX = e.clientX - this.offsetX;
    this.dragStartY = e.clientY - this.offsetY;
    this.container.setPointerCapture(e.pointerId);
    this.container.style.transition = 'none';
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    if (Math.abs(dx - this.offsetX) > 3 || Math.abs(dy - this.offsetY) > 3) {
      this.hasMoved = true;
    }
    this.offsetX = dx;
    this.offsetY = dy;
    this.container.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private onPointerUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.container.style.transition = '';

    if (!this.hasMoved) {
      if (this.onTap) {
        this.onTap();
      }
    }
  }

  destroy(): void {
    this.stopNoise();
    this.stopMiniCanvasMirror();
  }
}

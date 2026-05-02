/**
 * OTA upgrade controller — server-orchestrated firmware update.
 *
 * The Unitree cloud handles the actual byte transfer + apply on the robot.
 * This module just kicks off the job and polls progress; it owns no firmware
 * data of its own.
 *
 * Two flows exist (matches the official APK):
 *   • Go2 / quadruped: single-shot `firmware/package/upgrade`. Progress goes
 *     0 → total in one phase; UI label flips at 50% from "Downloading" to
 *     "Installing".
 *   • G1 / Explorer:   two-step. First `firmware/package/download` runs the
 *     download phase (current goes 0 → 500). When current reaches 500 the
 *     UI prompts the user to start `firmware/package/install`, which then
 *     drives current 500 → 1000.
 *
 * Resume support: on mount, callers should first hit
 * `cloudApi.getCurrentUpgradeTask(sn)`. If it returns a non-empty updateId,
 * adopt it via `attach()` instead of starting fresh.
 */

import { cloudApi, type FirmwareInfo, type UpgradeProgress } from './unitree-cloud';

export type Family = 'Go2' | 'G1';

export type OtaPhase =
  | 'idle'
  | 'starting'         // POST upgrade/download was issued, awaiting updateId
  | 'downloading'      // poll loop running, current < 500 (G1) / current < total/2 (Go2)
  | 'awaiting-install' // G1 only: download finished, user must trigger install
  | 'installing'       // poll loop running, install phase
  | 'completed'
  | 'failed';

export interface OtaState {
  phase: OtaPhase;
  /** 0–100, scoped to the current phase (download bar resets when install starts on G1). */
  progressPct: number;
  /** Last raw progress values from the cloud, useful for debugging. */
  current: number;
  total: number;
  /** Last error message if `phase === 'failed'`. */
  message?: string;
  /** updateId currently being polled. */
  updateId?: string;
}

export type OtaListener = (s: OtaState) => void;

/** Polling cadence + offline budget — same numbers the APK uses
 *  (CheckProgressRunnable: 1 s tick, 20-tick offline limit). */
const POLL_INTERVAL_MS = 1000;
const OFFLINE_TICK_LIMIT = 20;

export class OtaController {
  private state: OtaState = { phase: 'idle', progressPct: 0, current: 0, total: 0 };
  private listeners = new Set<OtaListener>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTicks = 0;
  private cancelled = false;

  constructor(
    private readonly sn: string,
    private readonly family: Family,
    private readonly firmware: FirmwareInfo,
  ) {}

  getState(): OtaState { return { ...this.state }; }

  subscribe(cb: OtaListener): () => void {
    this.listeners.add(cb);
    cb(this.getState());
    return () => this.listeners.delete(cb);
  }

  /** Begin a fresh upgrade. Picks single-shot vs two-step download based
   *  on family. For G1, if the firmware bean already says
   *  `alreadyDownload === '1'` the controller skips download and routes
   *  straight to the awaiting-install state — the caller can call
   *  `startInstall()` immediately. */
  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'failed' && this.state.phase !== 'completed') {
      throw new Error(`Cannot start: already in phase "${this.state.phase}"`);
    }

    // G1 with package already on the robot — skip download phase.
    if (this.family === 'G1' && this.firmware.alreadyDownload === '1') {
      this.update({ phase: 'awaiting-install', progressPct: 0, current: 0, total: 0 });
      return;
    }

    this.update({ phase: 'starting', progressPct: 0, current: 0, total: 0 });
    try {
      const updateId = this.family === 'G1'
        ? await cloudApi.startFirmwareDownload(this.sn, this.firmware.firmwareId)
        : await cloudApi.startFirmwareUpgrade(this.sn, this.firmware.firmwareId);
      this.update({ phase: 'downloading', updateId });
      this.scheduleNextPoll();
    } catch (e) {
      this.fail(e);
    }
  }

  /** G1 only — kick off the install phase after download completes. */
  async startInstall(): Promise<void> {
    if (this.family !== 'G1') throw new Error('startInstall is G1-only');
    if (this.state.phase !== 'awaiting-install') {
      throw new Error(`Cannot install: phase is "${this.state.phase}"`);
    }
    this.update({ phase: 'starting', progressPct: 0 });
    try {
      const updateId = await cloudApi.startFirmwareInstall(this.sn, this.firmware.firmwareId);
      this.update({ phase: 'installing', updateId });
      this.scheduleNextPoll();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Re-attach to an in-flight job (recovered via getCurrentUpgradeTask).
   *  Skips the start endpoint and jumps straight into the poll loop. The
   *  current phase is inferred from the first poll's `current` value. */
  attach(updateId: string): void {
    this.cancelled = false;
    this.offlineTicks = 0;
    // Provisionally mark as downloading; the first poll classifies into
    // download/install based on current < 500 (G1) or current < total/2 (Go2).
    this.update({ phase: 'downloading', updateId, progressPct: 0, current: 0, total: 0 });
    this.scheduleNextPoll();
  }

  /** Stop polling and release listeners. The cloud-side job keeps running
   *  — cancel only severs the local UI's interest. */
  cancel(): void {
    this.cancelled = true;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private scheduleNextPoll(): void {
    if (this.cancelled) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (this.cancelled) return;
    const updateId = this.state.updateId;
    if (!updateId) return;

    let r: UpgradeProgress;
    try {
      r = await cloudApi.getUpgradeProgress(updateId);
    } catch {
      this.bumpOffline();
      return;
    }

    // code != 0 → APK treats this as the device having lost the cloud
    // session. Same semantics here.
    if (r.code !== 0) {
      this.bumpOffline();
      return;
    }
    this.offlineTicks = 0;

    // Completion: current === total. The robot will reboot shortly after.
    if (r.current >= r.total && r.total > 0) {
      this.update({
        phase: 'completed',
        progressPct: 100,
        current: r.current,
        total: r.total,
      });
      this.cancel();
      return;
    }

    // Phase-aware progress mapping.
    if (this.family === 'G1') {
      // 0–500 download → 0–100% on the download bar.
      // 500 boundary → "awaiting-install" (user must tap Install).
      // 500–1000 install → 0–100% on the install bar.
      if (r.current < 500) {
        const pct = (r.current / 500) * 100;
        this.update({ phase: 'downloading', progressPct: pct, current: r.current, total: r.total });
      } else if (r.current === 500) {
        this.update({ phase: 'awaiting-install', progressPct: 0, current: r.current, total: r.total });
        this.cancel();   // Stop polling until user triggers install.
        return;
      } else {
        const pct = ((r.current - 500) / 500) * 100;
        this.update({ phase: 'installing', progressPct: pct, current: r.current, total: r.total });
      }
    } else {
      // Go2 single-shot. Whole 0..total range = one progress bar.
      // Label flips at the 50% mark from "Downloading" → "Installing"
      // (matches APK string-resource swap).
      const pct = (r.current * 100) / r.total;
      this.update({
        phase: pct < 50 ? 'downloading' : 'installing',
        progressPct: Math.max(1, pct),
        current: r.current,
        total: r.total,
      });
    }

    this.scheduleNextPoll();
  }

  private bumpOffline(): void {
    this.offlineTicks++;
    if (this.offlineTicks >= OFFLINE_TICK_LIMIT) {
      this.update({ phase: 'failed', message: 'Robot offline — upgrade aborted.' });
      this.cancel();
      return;
    }
    this.scheduleNextPoll();
  }

  private fail(e: unknown): void {
    this.update({ phase: 'failed', message: e instanceof Error ? e.message : String(e) });
    this.cancel();
  }

  private update(patch: Partial<OtaState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) {
      try { cb(this.getState()); } catch { /* ignore */ }
    }
  }
}

import { SPORT_CMD } from '../../protocol/topics';
import { cloudApi, type RobotFamily } from '../../api/unitree-cloud';

export interface RobotAction {
  apiId: number;
  name: string;
  icon: string;
  /** JSON parameter string sent with the request. Defaults to '{}'. */
  param?: string;
  /** Which robot families support this action. Defaults to ['Go2'] when omitted. */
  families?: ReadonlyArray<RobotFamily>;
}

const DATA_TRUE = '{"data":true}';

// Family tagging policy: each list below is single-family. Go2 actions
// fire against rt/api/sport/request with SPORT_CMD api_ids; G1 actions
// fire against rt/api/arm/request with the api_ids encoded in the
// Explorer 1.9.3 bundle (verified against index-CtgArt9k.js cge fn).
// The action bar swaps lists at render time on cloudApi.connectFamily.
const GO2: ReadonlyArray<RobotFamily> = ['Go2'];
const G1:  ReadonlyArray<RobotFamily> = ['G1'];

/** Go2 actions (tricks/gestures) — fire to rt/api/sport/request. */
export const GO2_ACTIONS: RobotAction[] = [
  { apiId: SPORT_CMD.Wallow, name: 'Roll Over', icon: '/icons/rollOver.svg', families: GO2 },
  { apiId: SPORT_CMD.Stretch, name: 'Stretch', icon: '/icons/stretch.svg', families: GO2 },
  { apiId: SPORT_CMD.Hello, name: 'Shake Hand', icon: '/icons/shakeHands.svg', families: GO2 },
  { apiId: SPORT_CMD.FingerHeart, name: 'Heart', icon: '/icons/showHeart.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontPounce, name: 'Pounce', icon: '/icons/pounceForward.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontJump, name: 'Jump Fwd', icon: '/icons/jumpForward.svg', families: GO2 },
  { apiId: SPORT_CMD.Scrape, name: 'Greet', icon: '/icons/newYear.svg', families: GO2 },
  { apiId: SPORT_CMD.Dance1, name: 'Dance 1', icon: '/icons/dance1.svg', families: GO2 },
  { apiId: SPORT_CMD.Dance2, name: 'Dance 2', icon: '/icons/dance2.svg', families: GO2 },
  { apiId: SPORT_CMD.FrontFlip, name: 'Front Flip', icon: '/sprites/icon_flip_forward.png', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.BackFlip, name: 'Back Flip', icon: '/icons/hand_stand.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.LeftFlip, name: 'Left Flip', icon: '/icons/mode_bound.svg', param: DATA_TRUE, families: GO2 },
  // Moved from modes: these are one-shot postures, not persistent modes
  { apiId: SPORT_CMD.Damp, name: 'Damping', icon: '/icons/mode_damping.svg', families: GO2 },
  { apiId: SPORT_CMD.Sit, name: 'Sit Down', icon: '/icons/sitDown.svg', families: GO2 },
  { apiId: SPORT_CMD.StandDown, name: 'Crouch', icon: '/icons/lieDown.svg', families: GO2 },
  { apiId: SPORT_CMD.StandUp, name: 'Lock On', icon: '/icons/mode_locking.svg', families: GO2 },
];

/** Go2 modes (persistent postures) — fire to rt/api/sport/request. */
export const GO2_MODES: RobotAction[] = [
  { apiId: SPORT_CMD.FreeWalk, name: 'Free Walk', icon: '/icons/mode_freeWalk.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.Pose, name: 'Pose', icon: '/icons/mode_pose.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.SwitchGait, name: 'Run', icon: '/icons/mode_run.svg', param: '{"data":1}', families: GO2 },
  { apiId: SPORT_CMD.WalkStair, name: 'Walk Stair', icon: '/icons/mode_climbingStairs.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.StaticWalk, name: 'Static Walk', icon: '/icons/mode_walk.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.EconomicGait, name: 'Endurance', icon: '/icons/mode_batteryLife.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.LeadFollow, name: 'Leash', icon: '/icons/mode_traction.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.HandStand, name: 'Hand Stand', icon: '/icons/hand_stand.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.FreeAvoid, name: 'Free Avoid', icon: '/icons/mode_ai_avoid.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.FreeBound, name: 'Bound', icon: '/icons/mode_ai_bound.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.FreeJump, name: 'Jump', icon: '/icons/mode_bound.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.RecoveryStand, name: 'Stand', icon: '/icons/mode_stand.svg', families: GO2 },
  { apiId: SPORT_CMD.CrossStep, name: 'Cross Step', icon: '/icons/mode_crossStep.svg', param: DATA_TRUE, families: GO2 },
  // Moved from actions: these are persistent postures (remain active until next command)
  { apiId: SPORT_CMD.BackStand, name: 'Rear Stand', icon: '/icons/mode_ai_stand.svg', param: DATA_TRUE, families: GO2 },
  { apiId: SPORT_CMD.RageMode, name: 'Rage', icon: '/icons/mode_runaway.svg', param: DATA_TRUE, families: GO2 },
];

// G1 api_ids transcribed from Explorer 1.9.3 (cge function near
// index-CtgArt9k.js:73063). All G1 modes/actions route through
// rt/api/arm/request (G1_ARM_REQUEST) — see app.ts action-bar callback.
/** G1 actions (arm gestures). */
export const G1_ACTIONS: RobotAction[] = [
  { apiId: 27, name: 'Handshake',    icon: '/icons/g1/icon_active_shakeHands.svg',           families: G1 },
  { apiId: 18, name: 'High Five',    icon: '/icons/g1/icon_active_highFiveCmd.svg',          families: G1 },
  { apiId: 19, name: 'Hug',          icon: '/icons/g1/icon_active_hug.svg',                  families: G1 },
  { apiId: 26, name: 'High Wave',    icon: '/icons/g1/icon_active_hightWave.svg',            families: G1 },
  { apiId: 17, name: 'Clap',         icon: '/icons/g1/icon_active_clamp.svg',                families: G1 },
  { apiId: 25, name: 'Face Wave',    icon: '/icons/g1/icon_active_lowWave.svg',              families: G1 },
  { apiId: 12, name: 'Left Kiss',    icon: '/icons/g1/icon_active_blowKiss.svg',             families: G1 },
  { apiId: 20, name: 'Arm Heart',    icon: '/icons/g1/icon_active_makeHeartBothHands.svg',   families: G1 },
  { apiId: 21, name: 'Right Heart',  icon: '/icons/g1/icon_active_makeHeartSingleHands.svg', families: G1 },
  { apiId: 15, name: 'Hands Up',     icon: '/icons/g1/icon_active_bothHandsUp.svg',          families: G1 },
  { apiId: 23, name: 'X-Ray',        icon: '/icons/g1/icon_active_singleHandsUp.svg',        families: G1 },
  { apiId: 22, name: 'Reject',       icon: '/icons/g1/icon_active_refuse.svg',               families: G1 },
  { apiId: 36, name: 'Forward Push', icon: '/icons/g1/icon_active_forwardPush.svg',          families: G1 },
  { apiId: 99, name: 'Release',      icon: '/icons/g1/icon_active_shakeHands.svg',           families: G1 },
];

/** G1 modes (persistent postures / gaits). */
export const G1_MODES: RobotAction[] = [
  { apiId: 1,   name: 'Damping',       icon: '/icons/g1/icon_model_damping.svg',     families: G1 },
  { apiId: 0,   name: 'Zero Torque',   icon: '/icons/g1/icon_model_zeroTorque.svg',  families: G1 },
  { apiId: 4,   name: 'Preparation',   icon: '/icons/g1/icon_model_preparation.svg', families: G1 },
  { apiId: 3,   name: 'Seating',       icon: '/icons/g1/icon_model_seating.svg',     families: G1 },
  { apiId: 801, name: 'Run',           icon: '/icons/g1/icon_model_run.svg',         families: G1 },
  { apiId: 500, name: 'Walk',          icon: '/icons/g1/icon_model_g1_walk.svg',     families: G1 },
  { apiId: 501, name: 'Walk (Waist)',  icon: '/icons/g1/icon_model_g1_walk.svg',     families: G1 },
  { apiId: 503, name: 'Dance',         icon: '/icons/g1/icon_model_dance_g1.svg',    families: G1 },
  { apiId: 706, name: 'Squat',         icon: '/icons/g1/icon_model_squat.svg',       families: G1 },
  { apiId: 706, name: 'Squat Up',      icon: '/icons/g1/icon_model_squatUp.svg',     families: G1 },
  { apiId: 702, name: 'Lie Down',      icon: '/icons/g1/icon_model_lieUp.svg',       families: G1 },
  { apiId: 812, name: 'Climb',         icon: '/icons/g1/icon_model_climb.svg',       families: G1 },
];

// Legacy aliases retained so anything importing the old names keeps working.
export const ALL_ACTIONS = GO2_ACTIONS;
export const ALL_MODES = GO2_MODES;

/** Pick the action / mode list for the given (or current) family. */
export function actionsForFamily(family: RobotFamily = cloudApi.connectFamily): RobotAction[] {
  return family === 'G1' ? G1_ACTIONS : GO2_ACTIONS;
}
export function modesForFamily(family: RobotFamily = cloudApi.connectFamily): RobotAction[] {
  return family === 'G1' ? G1_MODES : GO2_MODES;
}

/** Whether this action is supported on the given (or current) robot family. */
export function actionSupports(a: RobotAction, family: RobotFamily = cloudApi.connectFamily): boolean {
  return (a.families ?? GO2).includes(family);
}

export type ActionCallback = (action: RobotAction) => void;

interface ShortcutRef {
  type: 'action' | 'mode';
  index: number;
}

/** Default shortcut bar items */
const DEFAULT_SHORTCUTS: ShortcutRef[] = [
  { type: 'action', index: 0 },
  { type: 'action', index: 1 },
  { type: 'action', index: 2 },
  { type: 'action', index: 3 },
  { type: 'action', index: 4 },
];

export class ActionBar {
  private container: HTMLElement;
  private island: HTMLElement;
  private popup: HTMLElement | null = null;
  private onAction: ActionCallback;
  private editing = false;

  // Items that appear in the shortcut bar
  private shortcuts: ShortcutRef[];

  // Touch scroll state
  private scrollStartX = 0;
  private scrollLeft = 0;
  private isDragging = false;
  private hasDragged = false;

  constructor(parent: HTMLElement, onAction: ActionCallback) {
    this.onAction = onAction;
    this.shortcuts = [...DEFAULT_SHORTCUTS];

    this.container = document.createElement('div');
    this.container.className = 'action-bar-container';

    // Oval transparent island
    this.island = document.createElement('div');
    this.island.className = 'action-island';

    // Grid icon button (4-square) on the left
    const gridBtn = document.createElement('button');
    gridBtn.className = 'action-grid-btn';
    gridBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="1" y="1" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="12" y="1" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="1" y="12" width="7" height="7" rx="1.5" fill="white"/>
      <rect x="12" y="12" width="7" height="7" rx="1.5" fill="white"/>
    </svg>`;
    gridBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopup();
    });
    this.island.appendChild(gridBtn);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'action-island-divider';
    this.island.appendChild(divider);

    // Scrollable action area
    const scrollArea = document.createElement('div');
    scrollArea.className = 'action-island-scroll';
    scrollArea.id = 'action-island-scroll';
    this.island.appendChild(scrollArea);

    this.container.appendChild(this.island);
    this.buildShortcutItems();
    this.setupScrollHandlers();
    parent.appendChild(this.container);
  }

  private buildShortcutItems(): void {
    const scrollArea = this.island.querySelector('#action-island-scroll')!;
    scrollArea.innerHTML = '';

    for (const ref of this.shortcuts) {
      const list = ref.type === 'action' ? actionsForFamily() : modesForFamily();
      const action = list[ref.index];
      if (!action) continue;
      if (!actionSupports(action)) continue;
      const btn = document.createElement('button');
      btn.className = 'action-island-item';
      btn.innerHTML = `
        <div class="action-icon-wrap">
          <img src="${action.icon}" alt="${action.name}" draggable="false" />
        </div>
        <span>${action.name}</span>
      `;
      btn.addEventListener('click', (e) => {
        if (this.hasDragged) { e.preventDefault(); return; }
        btn.classList.add('active-state');
        setTimeout(() => btn.classList.remove('active-state'), 300);
        this.onAction(action);
      });
      scrollArea.appendChild(btn);
    }

    // "+" add button at the end of carousel (opens popup in edit mode)
    const addBtn = document.createElement('button');
    addBtn.className = 'action-island-item action-add-btn';
    addBtn.innerHTML = `
      <div class="action-icon-wrap">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="11" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" stroke-dasharray="4 3"/>
          <line x1="12" y1="7" x2="12" y2="17" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round"/>
          <line x1="7" y1="12" x2="17" y2="12" stroke="rgba(255,255,255,0.6)" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <span>Add</span>
    `;
    addBtn.addEventListener('click', (e) => {
      if (this.hasDragged) { e.preventDefault(); return; }
      this.openPopupInEditMode();
    });
    scrollArea.appendChild(addBtn);
  }

  private setupScrollHandlers(): void {
    const scrollArea = this.island.querySelector('#action-island-scroll') as HTMLElement;
    if (!scrollArea) return;

    scrollArea.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.hasDragged = false;
      this.scrollStartX = e.clientX;
      this.scrollLeft = scrollArea.scrollLeft;
      scrollArea.style.cursor = 'grabbing';
    });

    scrollArea.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.scrollStartX;
      if (Math.abs(dx) > 5) this.hasDragged = true;
      scrollArea.scrollLeft = this.scrollLeft - dx;
    });

    const endDrag = () => {
      this.isDragging = false;
      const scrollArea = this.island.querySelector('#action-island-scroll') as HTMLElement;
      if (scrollArea) scrollArea.style.cursor = '';
    };
    scrollArea.addEventListener('pointerup', endDrag);
    scrollArea.addEventListener('pointercancel', endDrag);
  }

  // ── Popup (Action/Mode grid with Edit mode) ──

  private togglePopup(): void {
    if (this.popup) {
      this.closePopup();
      return;
    }
    this.openPopup();
  }

  private openPopup(): void {
    this.editing = false;
    this.popup = document.createElement('div');
    this.popup.className = 'action-popup';

    const header = document.createElement('div');
    header.className = 'action-popup-header';
    header.innerHTML = `<span class="action-popup-title">All</span>`;
    const editBtn = document.createElement('button');
    editBtn.className = 'action-popup-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      this.editing = !this.editing;
      editBtn.textContent = this.editing ? 'Done' : 'Edit';
      this.rebuildPopupGrid();
    });
    header.appendChild(editBtn);
    this.popup.appendChild(header);

    // Action section
    const actionSection = document.createElement('div');
    actionSection.className = 'action-popup-section';
    actionSection.innerHTML = '<div class="action-popup-section-title">Action</div>';
    const actionGrid = document.createElement('div');
    actionGrid.className = 'action-popup-grid';
    actionGrid.id = 'popup-action-grid';
    actionSection.appendChild(actionGrid);
    this.popup.appendChild(actionSection);

    // Mode section
    const modeSection = document.createElement('div');
    modeSection.className = 'action-popup-section';
    modeSection.innerHTML = '<div class="action-popup-section-title">Mode</div>';
    const modeGrid = document.createElement('div');
    modeGrid.className = 'action-popup-grid';
    modeGrid.id = 'popup-mode-grid';
    modeSection.appendChild(modeGrid);
    this.popup.appendChild(modeSection);

    this.container.appendChild(this.popup);
    this.rebuildPopupGrid();

    const closeHandler = (e: PointerEvent) => {
      if (this.popup && !this.popup.contains(e.target as Node) &&
          !(e.target as HTMLElement).closest('.action-grid-btn')) {
        this.closePopup();
        document.removeEventListener('pointerdown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeHandler), 0);
  }

  private closePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
      this.editing = false;
    }
  }

  private rebuildPopupGrid(): void {
    const actionGrid = this.popup?.querySelector('#popup-action-grid');
    const modeGrid = this.popup?.querySelector('#popup-mode-grid');
    if (!actionGrid || !modeGrid) return;

    actionGrid.innerHTML = '';
    modeGrid.innerHTML = '';

    actionsForFamily().forEach((action, idx) => {
      actionGrid.appendChild(this.createPopupItem(action, idx, 'action'));
    });

    modesForFamily().forEach((mode, idx) => {
      modeGrid.appendChild(this.createPopupItem(mode, idx, 'mode'));
    });
  }

  private isInShortcuts(type: 'action' | 'mode', index: number): boolean {
    return this.shortcuts.some((s) => s.type === type && s.index === index);
  }

  private createPopupItem(action: RobotAction, itemIdx: number, type: 'action' | 'mode'): HTMLElement {
    const item = document.createElement('div');
    item.className = 'action-popup-item';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'action-popup-icon';
    iconWrap.innerHTML = `<img src="${action.icon}" alt="${action.name}" draggable="false" />`;
    item.appendChild(iconWrap);

    const label = document.createElement('span');
    label.className = 'action-popup-label';
    label.textContent = action.name;
    item.appendChild(label);

    if (this.editing) {
      const isInBar = this.isInShortcuts(type, itemIdx);
      const badge = document.createElement('div');
      badge.className = `action-popup-badge ${isInBar ? 'badge-remove' : 'badge-add'}`;
      badge.textContent = isInBar ? '−' : '+';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isInBar) {
          this.shortcuts = this.shortcuts.filter((s) => !(s.type === type && s.index === itemIdx));
        } else {
          this.shortcuts.push({ type, index: itemIdx });
        }
        this.buildShortcutItems();
        this.rebuildPopupGrid();
      });
      item.appendChild(badge);
    } else {
      item.addEventListener('click', () => {
        this.onAction(action);
        this.closePopup();
      });
    }

    return item;
  }

  private openPopupInEditMode(): void {
    if (this.popup) this.closePopup();
    this.openPopup();
    // Switch to edit mode
    this.editing = true;
    const editBtn = this.popup?.querySelector('.action-popup-edit-btn') as HTMLButtonElement;
    if (editBtn) editBtn.textContent = 'Done';
    this.rebuildPopupGrid();
  }

  toggleMode(): void {
    this.togglePopup();
  }
}

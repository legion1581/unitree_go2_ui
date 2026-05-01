/**
 * Cloud preferences pill row — robot family + (optionally) region.
 *
 * Shared by the connection panel and the post-connect hub. Selections persist
 * via the cloudApi singleton (localStorage), so the component is stateless
 * w.r.t. its own DOM lifecycle: just call `buildCloudPrefsRow()` to mount.
 */

import { cloudApi, ROBOT_FAMILIES, REGIONS, FAMILY_LABEL, type RobotFamily, type Region } from '../../api/unitree-cloud';

export interface CloudPrefsOptions {
  /** Show the Family toggle (Go2 / G1). Default true. */
  showFamily?: boolean;
  /** Show the Region toggle (Global / CN). Default true. */
  showRegion?: boolean;
  /** Fired after the user clicks a different value, with the new state. */
  onChange?: (family: RobotFamily, region: Region) => void;
}

export function buildCloudPrefsRow(options: CloudPrefsOptions = {}): HTMLElement {
  const showFamily = options.showFamily ?? true;
  const showRegion = options.showRegion ?? true;

  const row = document.createElement('div');
  row.className = 'cloud-prefs-row';
  row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;margin:8px 0 14px;';

  const renderToggleGroup = <T extends string>(
    values: ReadonlyArray<T>,
    get: () => T,
    set: (v: T) => void,
    label: (v: T) => string,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'cloud-prefs-group';
    group.style.cssText = 'display:inline-flex;border:1px solid #2a2d35;border-radius:6px;overflow:hidden;';
    const repaint = (): void => {
      group.innerHTML = '';
      for (const v of values) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const active = get() === v;
        btn.textContent = label(v);
        btn.style.cssText = `padding:5px 11px;border:none;font-size:11px;font-weight:600;letter-spacing:0.4px;cursor:${active ? 'default' : 'pointer'};background:${active ? '#4fc3f7' : 'transparent'};color:${active ? '#000' : '#888'};transition:background 0.12s,color 0.12s;`;
        btn.addEventListener('click', () => {
          if (get() === v) return;
          set(v);
          repaint();
          options.onChange?.(cloudApi.family, cloudApi.region);
        });
        group.appendChild(btn);
      }
    };
    repaint();
    return group;
  };

  const labeledGroup = (text: string, group: HTMLElement): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;';
    lbl.textContent = text;
    wrap.append(lbl, group);
    return wrap;
  };

  if (showFamily) {
    row.appendChild(labeledGroup(
      'Family',
      renderToggleGroup<RobotFamily>(ROBOT_FAMILIES, () => cloudApi.family, (v) => cloudApi.setFamily(v), (v) => FAMILY_LABEL[v]),
    ));
  }

  if (showRegion) {
    row.appendChild(labeledGroup(
      'Region',
      renderToggleGroup<Region>(REGIONS, () => cloudApi.region, (v) => cloudApi.setRegion(v), (v) => v === 'global' ? 'Global' : 'CN'),
    ));
  }

  return row;
}

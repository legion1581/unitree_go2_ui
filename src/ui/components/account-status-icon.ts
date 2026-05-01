/**
 * Floating account-status indicator — sits to the left of the theme toggle.
 * Color and tooltip reflect cloudApi login state. Click opens the Account
 * Manager (all configuration / login lives there).
 */

import { cloudApi } from '../../api/unitree-cloud';

const USER_SVG = (color: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
  <circle cx="12" cy="7" r="4"/>
</svg>`;

export class AccountStatusIcon {
  private container: HTMLElement;
  private iconWrap: HTMLElement;
  private tooltip: HTMLElement;
  private unsubscribe: () => void;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'account-status-icon';
    // Sits to the left of the theme toggle (right:58px, w:36 + 8px gap = 102).
    this.container.style.cssText = 'position:fixed;top:12px;right:102px;z-index:9000;display:flex;align-items:center;pointer-events:auto;';

    // Pure status indicator — no click action, just hover tooltip.
    this.iconWrap = document.createElement('div');
    this.iconWrap.style.cssText = 'width:36px;height:36px;border-radius:50%;background:rgba(26,29,35,0.95);border:1.5px solid #3a3d45;display:flex;align-items:center;justify-content:center;cursor:default;transition:all 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    this.container.appendChild(this.iconWrap);

    this.tooltip = document.createElement('div');
    this.tooltip.style.cssText = 'position:absolute;top:38px;right:0;background:rgba(15,17,20,0.95);border:1px solid #1f2229;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;white-space:nowrap;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    this.container.appendChild(this.tooltip);

    this.iconWrap.addEventListener('mouseenter', () => {
      this.tooltip.style.display = 'block';
    });
    this.iconWrap.addEventListener('mouseleave', () => {
      this.tooltip.style.display = 'none';
    });

    parent.appendChild(this.container);
    this.unsubscribe = cloudApi.onAuthChange(() => this.render());
    this.render();
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? 'flex' : 'none';
  }

  private render(): void {
    const loggedIn = cloudApi.isLoggedIn;
    const color = loggedIn ? '#4fc3f7' : '#b0b3bb';
    this.iconWrap.innerHTML = USER_SVG(color);
    this.iconWrap.style.borderColor = loggedIn ? 'rgba(79,195,247,0.5)' : '#3a3d45';
    this.iconWrap.style.background = loggedIn ? 'rgba(79,195,247,0.15)' : 'rgba(26,29,35,0.95)';

    if (loggedIn) {
      const u = cloudApi.user;
      const username = u?.nickname?.trim() || u?.email?.trim() || 'account';
      const email = u?.email?.trim() || '';
      const lines = [
        `<div><strong style="color:#4fc3f7;">Logged in as user:</strong> ${this.esc(username)}</div>`,
      ];
      if (email && email !== username) {
        lines.push(`<div style="color:#999;margin-top:2px;">${this.esc(email)}</div>`);
      }
      this.tooltip.innerHTML = lines.join('');
    } else {
      this.tooltip.innerHTML = '<div style="color:#888;">Not logged in</div>';
    }
  }

  private esc(s: string): string {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  destroy(): void {
    this.unsubscribe();
    this.container.remove();
  }
}

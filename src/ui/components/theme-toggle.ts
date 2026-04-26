/**
 * Floating theme toggle (sun/moon) — sits to the left of the BT status icon.
 * Click to flip dark <-> light.
 */

import { theme } from '../theme';

const SUN_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFB74D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4"/>
  <line x1="12" y1="2" x2="12" y2="5"/>
  <line x1="12" y1="19" x2="12" y2="22"/>
  <line x1="2" y1="12" x2="5" y2="12"/>
  <line x1="19" y1="12" x2="22" y2="12"/>
  <line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/>
  <line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/>
  <line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/>
  <line x1="17.5" y1="6.5" x2="19.5" y2="4.5"/>
</svg>`;

const MOON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3bb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>
</svg>`;

export class ThemeToggle {
  private container: HTMLElement;
  private iconWrap: HTMLElement;
  private unsubscribe: () => void;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'theme-toggle-icon';
    // Positioned to the left of the BT status icon (which sits at right:14px with w:36)
    this.container.style.cssText = 'position:fixed;top:12px;right:58px;z-index:9000;';

    this.iconWrap = document.createElement('div');
    this.iconWrap.style.cssText = 'width:36px;height:36px;border-radius:50%;background:rgba(26,29,35,0.95);border:1.5px solid #3a3d45;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.15s;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    this.container.appendChild(this.iconWrap);

    this.iconWrap.addEventListener('mouseenter', () => {
      this.iconWrap.style.background = 'rgba(255,183,77,0.15)';
      this.iconWrap.style.transform = 'scale(1.05)';
    });
    this.iconWrap.addEventListener('mouseleave', () => {
      this.iconWrap.style.background = 'rgba(26,29,35,0.95)';
      this.iconWrap.style.transform = 'scale(1)';
    });
    this.iconWrap.addEventListener('click', () => theme().toggle());

    this.render(theme().theme);
    this.unsubscribe = theme().onChange((t) => this.render(t));

    parent.appendChild(this.container);
  }

  private render(t: 'dark' | 'light'): void {
    // Dark mode shows moon (you're currently in the dark, click to go light)
    // Light mode shows sun (you're currently in the light, click to go dark)
    this.iconWrap.innerHTML = t === 'dark' ? MOON_SVG : SUN_SVG;
    this.iconWrap.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? 'flex' : 'none';
  }

  destroy(): void {
    this.unsubscribe();
    this.container.remove();
  }
}

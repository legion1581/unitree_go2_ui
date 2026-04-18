/**
 * Global theme manager — dark (default) / light.
 * Persists to localStorage, applies a class on <html>, and fires events
 * so components can react (e.g. Three.js scene background + grid color).
 */

export type Theme = 'dark' | 'light';

export interface ThemeColors {
  background: number;   // Three.js scene background (0xRRGGBB)
  grid: number;         // Three.js grid line color
}

const STORAGE_KEY = 'go2ui.theme';

export const DARK_COLORS: ThemeColors = {
  background: 0x282828, // APK: new THREE.Color(2631720) == 0x282828
  grid: 0x888888,       // APK: new GridHelper(30, 30, 8947848) == 0x888888
};

export const LIGHT_COLORS: ThemeColors = {
  background: 0xf2f3f7, // near-white with a cool tint
  grid: 0x6879e4,       // bluish-purple accent (matches app accent)
};

type Listener = (theme: Theme, colors: ThemeColors) => void;

class ThemeManager {
  private current: Theme;
  private listeners: Set<Listener> = new Set();

  constructor() {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    this.current = saved === 'light' ? 'light' : 'dark';
    this.apply();
  }

  get theme(): Theme { return this.current; }

  get colors(): ThemeColors {
    return this.current === 'light' ? LIGHT_COLORS : DARK_COLORS;
  }

  set(theme: Theme): void {
    if (theme === this.current) return;
    this.current = theme;
    localStorage.setItem(STORAGE_KEY, theme);
    this.apply();
  }

  toggle(): void {
    this.set(this.current === 'dark' ? 'light' : 'dark');
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private apply(): void {
    document.documentElement.setAttribute('data-theme', this.current);
    for (const cb of this.listeners) {
      try { cb(this.current, this.colors); } catch {}
    }
  }
}

let _instance: ThemeManager | null = null;
export function theme(): ThemeManager {
  if (!_instance) _instance = new ThemeManager();
  return _instance;
}

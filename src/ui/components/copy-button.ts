/**
 * Shared copy-to-clipboard button. Icon-only (clipboard SVG → checkmark on
 * success), unified styling across the app — see .copy-btn rules in
 * styles.css.
 */

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

export interface CopyButtonOptions {
  /** Pixel size of the button. Default 24. */
  size?: number;
  /** Extra class names to merge onto the button. */
  className?: string;
  /** Tooltip override; defaults to "Copy to clipboard". */
  title?: string;
}

/**
 * Build a copy-to-clipboard button. `text` can be a literal string or a
 * getter — pass a getter when the value isn't known at button-creation
 * time (e.g. a response panel whose contents update on every request).
 */
export function makeCopyButton(
  text: string | (() => string),
  options: CopyButtonOptions = {},
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const cls = ['copy-btn'];
  if (options.className) cls.push(options.className);
  btn.className = cls.join(' ');
  if (options.size && options.size !== 24) {
    btn.style.width = `${options.size}px`;
    btn.style.height = `${options.size}px`;
  }
  btn.title = options.title ?? 'Copy to clipboard';
  btn.innerHTML = CLIPBOARD_ICON;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const value = typeof text === 'function' ? text() : text;
    try {
      await navigator.clipboard.writeText(value);
      btn.classList.add('copy-btn-success');
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => {
        btn.classList.remove('copy-btn-success');
        btn.innerHTML = CLIPBOARD_ICON;
      }, 1200);
    } catch {
      btn.classList.add('copy-btn-error');
      setTimeout(() => btn.classList.remove('copy-btn-error'), 1200);
    }
  });
  return btn;
}

/**
 * Modal that asks the user for the 16-byte AES-128 key required to decrypt
 * a `data2 === 3` con_notify payload. Resolves with the trimmed hex string,
 * or rejects on cancel. Tied to a specific SN for caching downstream.
 *
 * `opts.previousKeyFailed` flips the modal into a "the previous key didn't
 * decrypt" state so the user knows the cached / just-entered key was wrong
 * and not just that the robot is rejecting them outright.
 */
export interface AesKeyPromptOptions {
  previousKeyFailed?: boolean;
}

export function promptAesKey(sn: string, opts: AesKeyPromptOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#181b21;border:1px solid #2a2d35;border-radius:10px;padding:18px 20px;width:min(90vw,440px);font-family:inherit;color:#fff;';
    overlay.appendChild(panel);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;';
    title.textContent = opts.previousKeyFailed ? 'AES-128 key didn’t decrypt — try again' : 'AES-128 key required';
    panel.appendChild(title);

    if (opts.previousKeyFailed) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:#ef9a9a;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.35);border-radius:6px;padding:6px 10px;margin-bottom:10px;';
      warn.textContent = 'The previous key failed to decrypt the robot’s con_notify reply. Paste a different one — the bad key has been flushed from cache.';
      panel.appendChild(warn);
    }

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:#9aa0aa;line-height:1.5;margin-bottom:12px;';
    sub.innerHTML = `The robot answered <code style="color:#b3c0ff;">data2=3</code>. Paste the 16-byte AES key (hex) for <code style="color:#b3c0ff;font-family:monospace;">${sn || '(unknown SN)'}</code>. Derive one in Account → device tile → "AES Key" if you don't have it.`;
    panel.appendChild(sub);

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '32 hex chars';
    input.className = 'acct-input';
    input.style.cssText = 'width:100%;padding:8px 10px;font-family:monospace;font-size:12px;box-sizing:border-box;';
    panel.appendChild(input);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:#e57373;margin-top:6px;min-height:14px;';
    panel.appendChild(status);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    panel.appendChild(btnRow);

    const cleanup = (): void => { overlay.remove(); };

    const cancel = document.createElement('button');
    cancel.className = 'acct-btn acct-btn-secondary';
    cancel.style.cssText = 'padding:6px 14px;font-size:12px;';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { cleanup(); reject(new Error('AES key entry cancelled')); });
    btnRow.appendChild(cancel);

    const submit = document.createElement('button');
    submit.className = 'acct-btn';
    submit.style.cssText = 'padding:6px 14px;font-size:12px;';
    submit.textContent = 'Use key';
    const trySubmit = (): void => {
      const v = input.value.trim();
      if (!/^[0-9a-fA-F]+$/.test(v)) { status.textContent = 'Hex characters only.'; return; }
      if (v.length !== 32) { status.textContent = `Expected 32 hex chars, got ${v.length}.`; return; }
      cleanup();
      resolve(v.toLowerCase());
    };
    submit.addEventListener('click', trySubmit);
    btnRow.appendChild(submit);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') trySubmit();
      if (e.key === 'Escape') { cleanup(); reject(new Error('AES key entry cancelled')); }
    });

    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  });
}

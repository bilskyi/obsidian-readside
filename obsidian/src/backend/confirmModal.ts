import { Modal, type App } from 'obsidian';
import type { ConfirmOptions } from '../../../src/lib/backend';

class ConfirmModal extends Modal {
  private answered = false;
  private readonly message: string;
  private readonly opts: ConfirmOptions;
  private readonly done: (ok: boolean) => void;

  constructor(app: App, message: string, opts: ConfirmOptions, done: (ok: boolean) => void) {
    super(app);
    this.message = message;
    this.opts = opts;
    this.done = done;
  }

  onOpen(): void {
    this.setTitle(this.opts.title);
    const text = document.createElement('p');
    text.textContent = this.message;
    const row = document.createElement('div');
    row.className = 'modal-button-container';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = this.opts.cancelLabel ?? 'Cancel';
    cancel.addEventListener('click', () => this.answer(false));
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = this.opts.okLabel ?? 'OK';
    ok.className = this.opts.kind === 'warning' || this.opts.kind === 'error' ? 'mod-warning' : 'mod-cta';
    ok.addEventListener('click', () => this.answer(true));
    row.append(cancel, ok);
    this.contentEl.replaceChildren(text, row);
    ok.focus();
  }

  onClose(): void {
    if (!this.answered) {
      this.answered = true;
      this.done(false);
    }
    this.contentEl.replaceChildren();
  }

  private answer(ok: boolean): void {
    this.answered = true;
    this.done(ok);
    this.close();
  }
}

/** The plugin's Backend.confirm: an Obsidian modal; any way of closing it other than OK is "no". */
export function confirmModal(app: App, message: string, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, message, opts, resolve).open());
}

import { describe, expect, it } from 'vitest';
import { App, Modal } from 'obsidian';
import { confirmModal } from '../src/backend/confirmModal';

const button = (name: string) =>
  [...(Modal.opened[0]?.contentEl.querySelectorAll('button') ?? [])].find((b) => b.textContent === name)!;

describe('confirmModal', () => {
  it('shows the title and message; OK resolves true and closes', async () => {
    const p = confirmModal(new App(), 'Delete this thought?', { title: 'Delete Thought', kind: 'warning' });
    expect(Modal.opened[0].titleEl.textContent).toBe('Delete Thought');
    expect(Modal.opened[0].contentEl.textContent).toContain('Delete this thought?');
    expect(button('OK').className).toContain('mod-warning');
    button('OK').click();
    await expect(p).resolves.toBe(true);
    expect(Modal.opened).toHaveLength(0);
  });

  it('Cancel, or closing the modal any other way, resolves false; custom labels show', async () => {
    const p = confirmModal(new App(), 'Go?', { title: 'T', okLabel: 'Go', cancelLabel: 'Stay' });
    button('Stay').click();
    await expect(p).resolves.toBe(false);
    const q = confirmModal(new App(), 'Again?', { title: 'T' });
    Modal.opened[0].close();
    await expect(q).resolves.toBe(false);
  });

  it('the confirm button has default focus, so Enter confirms', async () => {
    const p = confirmModal(new App(), 'Go?', { title: 'T' });
    expect(document.activeElement).toBe(button('OK'));
    button('OK').click();
    await p;
  });
});

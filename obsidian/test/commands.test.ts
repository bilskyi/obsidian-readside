import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import type { App, TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { setBackend } from '../../src/lib/backend';
import { VIEW_COMMANDS } from '../src/commands';
import MarginPlugin from '../src/main';
import { makeApp, manifest, pdfBytes } from './helpers';

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;

async function setup() {
  app = makeApp();
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  plugin = new MarginPlugin(app, manifest);
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

afterEach(() => {
  plugin?.unload();
  plugin = null;
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
});

describe('reader commands', () => {
  it('registers the ten in-view commands', async () => {
    const p = await setup();
    expect(VIEW_COMMANDS.map((c) => c.id)).toEqual([
      'new-thought', 'toggle-notebook', 'toggle-contents', 'find', 'zoom-in', 'zoom-out', 'zoom-fit', 'next-page', 'prev-page', 'toggle-focus',
    ]);
    for (const c of VIEW_COMMANDS) expect(p.command(c.id).name).toBe(c.name);
  });

  it('are unavailable without a focused Margin view', async () => {
    const p = await setup();
    for (const c of VIEW_COMMANDS) expect(p.command(c.id).checkCallback!(true)).toBe(false);
  });

  it('with a Margin view focused, checking says yes and running acts on that view', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const toggle = p.command('toggle-notebook');
    expect(toggle.checkCallback!(true)).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'Notebook' })).toBeNull();
    act(() => {
      toggle.checkCallback!(false);
    });
    expect(await screen.findByRole('complementary', { name: 'Notebook' })).toBeTruthy();
  });
});

describe('Toggle focus mode command', () => {
  it('is available only with a Margin view focused, and toggles that view’s focus mode', async () => {
    const p = await setup();
    const focus = p.command('toggle-focus');
    expect(focus.name).toBe('Toggle focus mode');
    expect(focus.checkCallback!(true)).toBe(false);
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    expect(focus.checkCallback!(true)).toBe(true);
    expect(screen.queryByRole('group', { name: 'Reader controls' })).toBeNull();
    act(() => {
      focus.checkCallback!(false);
    });
    expect(await screen.findByRole('group', { name: 'Reader controls' })).toBeTruthy();
    act(() => {
      focus.checkCallback!(false);
    });
    expect(screen.queryByRole('group', { name: 'Reader controls' })).toBeNull();
  });
});

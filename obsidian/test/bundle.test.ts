// @vitest-environment node
// (esbuild refuses to run under jsdom: its Uint8Array checks fail across realms.)
import esbuild from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build helper without types
import { MAIN_JS_BUDGET, MPL_NOTICE, buildOptions } from '../scripts/buildOptions.mjs';

const out = mkdtempSync(join(tmpdir(), 'margin-bundle-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('main.js (production bundle, as pnpm build:obsidian makes it)', () => {
  it('carries the vendored Bergamot glue with its MPL-2.0 header, and stays within the size budget', async () => {
    const outfile = join(out, 'main.js');
    await esbuild.build({ ...buildOptions({ production: true, outfile }), logLevel: 'silent' });
    const js = readFileSync(outfile, 'utf8');
    expect(MPL_NOTICE).toBe('This Source Code Form is subject to the terms of the Mozilla Public');
    expect(js).toContain(MPL_NOTICE);
    // The translate host is wired: its strings are in the bundle (not tree-shaken away).
    expect(js).toContain("Readside couldn't start the translation engine");
    expect(Buffer.byteLength(js)).toBeLessThanOrEqual(MAIN_JS_BUDGET);
  }, 60_000);

  it('obsidian/dist/main.js, when built, has the header too', () => {
    const dist = join(__dirname, '..', 'dist', 'main.js');
    if (!existsSync(dist)) return; // a fresh checkout: the build script asserts it on every build
    expect(readFileSync(dist, 'utf8')).toContain(MPL_NOTICE);
  });
});

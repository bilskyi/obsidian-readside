// @vitest-environment node
// (esbuild refuses to run under jsdom: its Uint8Array checks fail across realms.)
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build helper without types
import { GLUE_FILE, buildWorkerScript, workerAssets } from '../scripts/workerAssetsPlugin.mjs';

const glue = readFileSync(GLUE_FILE, 'utf8');

/** Runs a worker script in a fresh worker-shaped global; returns how to talk to it. */
function runWorker(code: string) {
  const replies: unknown[] = [];
  const blobs = new Map<string, string>();
  const ctx: Record<string, unknown> = {
    console,
    Promise,
    queueMicrotask,
    Uint8Array,
    Blob,
    URL: {
      createObjectURL: (b: { text: string }) => {
        const url = `blob:test/${blobs.size + 1}`;
        blobs.set(url, b.text);
        return url;
      },
      revokeObjectURL: () => {},
    },
    postMessage: (m: unknown) => replies.push(m),
  };
  // A Blob whose text the fake createObjectURL can read synchronously.
  ctx.Blob = class {
    text: string;
    constructor(parts: string[]) {
      this.text = parts.join('');
    }
  };
  ctx.importScripts = (url: string) => vm.runInContext(blobs.get(url) ?? '', ctx);
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, replies };
}

describe('worker assets (esbuild)', () => {
  it('builds the worker into a self-contained script that starts itself in a worker scope', async () => {
    const { code } = await buildWorkerScript({ minify: true });
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).not.toContain('require(');
    const w = runWorker(code);
    expect(typeof w.ctx.onmessage).toBe('function');
    // A stand-in glue: loadBergamot that fails to start proves the glue ran via importScripts.
    const fakeGlue = 'function loadBergamot(m) { queueMicrotask(() => m.onAbort("no wasm here")); return m; }';
    (w.ctx.onmessage as (e: { data: unknown }) => void)({ data: { id: 7, type: 'init', glue: fakeGlue, wasm: new ArrayBuffer(1) } });
    for (let i = 0; i < 20 && w.replies.length === 0; i++) await Promise.resolve();
    expect(w.replies).toEqual([{ id: 7, ok: false, error: 'the engine aborted: no wasm here' }]);
  });

  it('does not start outside a worker (a page has window)', async () => {
    const { code } = await buildWorkerScript({ minify: false });
    const ctx: Record<string, unknown> = { importScripts: () => {} };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    expect(ctx.onmessage).toBeUndefined();
  });

  it('margin:worker-assets exports the built worker and the vendored glue as strings', async () => {
    const result = await esbuild.build({
      stdin: { contents: "import { WORKER_JS, GLUE_JS } from 'margin:worker-assets'; module.exports = { WORKER_JS, GLUE_JS };", resolveDir: process.cwd() },
      bundle: true,
      format: 'cjs',
      write: false,
      logLevel: 'silent',
      plugins: [workerAssets({ minify: true })],
    });
    const mod: { exports: { WORKER_JS?: string; GLUE_JS?: string } } = { exports: {} };
    new Function('module', result.outputFiles[0].text)(mod);
    expect(mod.exports.GLUE_JS).toBe(glue);
    expect(mod.exports.WORKER_JS).toBe((await buildWorkerScript({ minify: true })).code);
  });

  it('a production bundle of workerAssets.ts carries the glue verbatim, MPL-2.0 header included', async () => {
    const result = await esbuild.build({
      entryPoints: [new URL('../src/translate/workerAssets.ts', import.meta.url).pathname],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: ['es2022', 'chrome120'],
      minify: true,
      write: false,
      logLevel: 'silent',
      plugins: [workerAssets({ minify: true })],
    });
    const text = result.outputFiles[0].text;
    expect(text).toContain('This Source Code Form is subject to the terms of the Mozilla Public');
    const mod: { exports: { GLUE_JS?: string } } = { exports: {} };
    new Function('module', 'exports', text)(mod, mod.exports);
    expect(mod.exports.GLUE_JS).toBe(glue);
  });
});

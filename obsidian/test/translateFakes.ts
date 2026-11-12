// Fakes for the translation download/registry/host tests: no network, no disk.
import { MemoryAdapter } from 'obsidian';
import { ENGINE, PAIRS, type CatalogFile } from '../../src/translate/catalog';
import type { Fetcher } from '../src/translate/downloads';

export const TROOT = '.obsidian/plugins/margin-reader/translation';

/** MemoryAdapter plus the recursive rmdir the real DataAdapter has. */
export class TestAdapter extends MemoryAdapter {
  constructor() {
    super();
    for (const f of ['.obsidian', '.obsidian/plugins', '.obsidian/plugins/margin-reader']) this.folders.add(f);
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.calls.push(`rmdir ${path}`);
    const inside = (p: string) => p.startsWith(`${path}/`);
    if (!recursive && ([...this.files.keys()].some(inside) || [...this.folders].some(inside))) {
      throw new Error(`ENOTEMPTY: ${path}`);
    }
    for (const k of [...this.files.keys()]) if (inside(k)) this.files.delete(k);
    for (const k of [...this.folders]) if (inside(k)) this.folders.delete(k);
    this.folders.delete(path);
  }
  /** Every file path under `prefix`. */
  under(prefix: string): string[] {
    return [...this.files.keys()].filter((k) => k.startsWith(`${prefix}/`)).sort();
  }
}

const ALL_FILES: CatalogFile[] = [ENGINE.file, ...PAIRS.flatMap((p) => p.files)];
const BY_NAME = new Map(ALL_FILES.map((f) => [f.name, f]));

/** The catalog file's body as served by the fakes: its size, its name written at the start. */
export function bodyOf(file: CatalogFile, tag = file.name): Uint8Array {
  const b = new Uint8Array(file.size);
  b.set(new TextEncoder().encode(tag).subarray(0, file.size));
  return b;
}

/**
 * Stands in for sha256: a body that starts with a catalog file's name hashes to that file's sha256
 * (real hashing of fake bytes could never match the pinned hashes); anything else hashes to zeros.
 */
export async function fakeSha256(b: ArrayBuffer): Promise<string> {
  const head = new Uint8Array(b, 0, Math.min(80, b.byteLength));
  const end = head.indexOf(0);
  const name = new TextDecoder().decode(end < 0 ? head : head.subarray(0, end));
  return BY_NAME.get(name)?.sha256 ?? '0'.repeat(64);
}

export interface Served {
  status?: number;
  body?: Uint8Array;
  /** Reject with this after `failAfter` chunks. */
  error?: Error;
  failAfter?: number;
}

/**
 * A Fetcher serving catalog files from memory in 1 MiB chunks, one macrotask apart. `serve` can
 * override what a URL returns; `gets` counts requests per URL.
 */
export class FakeFetcher implements Fetcher {
  gets = new Map<string, number>();
  overrides = new Map<string, Served>();
  chunk = 1 << 20;

  total(): number {
    return [...this.gets.values()].reduce((s, n) => s + n, 0);
  }

  serve(url: string, s: Served): void {
    this.overrides.set(url, s);
  }

  async get(url: string, onChunk: (c: Uint8Array) => void, signal?: AbortSignal): Promise<{ status: number }> {
    this.gets.set(url, (this.gets.get(url) ?? 0) + 1);
    const file = ALL_FILES.find((f) => f.url === url);
    const o = this.overrides.get(url) ?? {};
    const status = o.status ?? (file ? 200 : 404);
    if (status !== 200) {
      await pause();
      return { status };
    }
    const body = o.body ?? (file ? bodyOf(file) : new Uint8Array(0));
    let n = 0;
    for (let at = 0; at < body.byteLength || at === 0; at += this.chunk) {
      await pause();
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (o.error && n === (o.failAfter ?? 0)) throw o.error;
      if (body.byteLength) onChunk(body.subarray(at, Math.min(body.byteLength, at + this.chunk)));
      n++;
      if (!body.byteLength) break;
    }
    if (o.error && n <= (o.failAfter ?? 0)) throw o.error;
    return { status };
  }
}

export const pause = () => new Promise<void>((r) => setTimeout(r, 0));

export function pairOf(from: string, to: string) {
  const p = PAIRS.find((x) => x.from === from && x.to === to);
  if (!p) throw new Error(`no pair ${from}-${to}`);
  return p;
}

/** The smallest catalog file, to keep download tests light. */
export const SMALL: CatalogFile = [...ALL_FILES].sort((a, b) => a.size - b.size)[0];

/**
 * Puts the engine and the given pairs on disk as if downloaded (zero bytes of the catalog sizes) and
 * records them in installed.json under `root`.
 */
export function installOnDisk(adapter: MemoryAdapter, root: string, pairs: [string, string][]): void {
  const folder = (p: string) => {
    let at = '';
    for (const part of p.split('/')) adapter.folders.add((at = at ? `${at}/${part}` : part));
  };
  // Each file is bodyOf(file): it hashes to the catalog's sha256 under fakeSha256.
  const put = (path: string, file: CatalogFile) => {
    folder(path.slice(0, path.lastIndexOf('/')));
    const body = bodyOf(file);
    adapter.files.set(path, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  };
  const sha12 = ENGINE.file.sha256.slice(0, 12);
  put(`${root}/engine/${sha12}/bergamot-translator.wasm`, ENGINE.file);
  const recorded: Record<string, unknown> = {};
  for (const [from, to] of pairs) {
    const p = pairOf(from, to);
    for (const f of p.files) put(`${root}/models/${from}-${to}/${p.version}/${f.name}`, f);
    recorded[`${from}-${to}`] = { version: p.version, files: p.files.map(({ name, sha256, size }) => ({ name, sha256, size })) };
  }
  folder(root);
  adapter.files.set(
    `${root}/installed.json`,
    JSON.stringify({ version: 1, engine: { sha256: ENGINE.file.sha256, size: ENGINE.file.size }, pairs: recorded }),
  );
}

// The registry of downloaded translation files: `<root>/installed.json` (root =
// `<configDir>/plugins/margin-reader/translation`). It is the only proof that a file was downloaded
// AND sha256-verified: a file on disk that the registry doesn't list is never used.
//
//  - Parsing is strict. Anything that is not exactly the documented shape (or names a path segment
//    that could escape the root) makes the whole file count as empty: nothing is installed, and the
//    next write replaces it. The user sees a download offer, never a crash or a stray read.
//  - A pair counts as installed only when it is listed with the asked version AND every listed file
//    exists with the listed size (the sha256 is checked once, at download). The same for the engine.
//  - Writes are serialised and use tmp → remove → rename, like the book files.
//  - removePair deletes the pair's folder and its entry; the shared engine goes only with the last
//    pair (and never while the caller says a download still needs it).
import type { DataAdapter } from 'obsidian';

export interface InstalledFile {
  name: string;
  sha256: string;
  size: number;
}

export interface InstalledPair {
  version: string;
  files: InstalledFile[];
}

export interface Installed {
  version: 1;
  engine: { sha256: string; size: number } | null;
  pairs: Record<string, InstalledPair>;
}

export const REGISTRY = 'installed.json';
export const ENGINE_FILE = 'bergamot-translator.wasm';

const SHA = /^[0-9a-f]{64}$/;
const LANG = '[a-z]{2,3}(?:-[A-Z][a-z]{3})?';
const PAIR_KEY = new RegExp(`^${LANG}-${LANG}$`);
const VERSION = /^[0-9]+(?:\.[0-9A-Za-z]+)*$/;
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export const emptyInstalled = (): Installed => ({ version: 1, engine: null, pairs: {} });

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const isPairKey = (k: string): boolean => PAIR_KEY.test(k);
export const isVersion = (v: string): boolean => VERSION.test(v);
/** A file name the registry accepts: one plain path segment, never a `.part`. */
export const isFileName = (n: string): boolean => FILE_NAME.test(n) && !n.endsWith('.part');
export const isSha256 = (h: string): boolean => SHA.test(h);

/** The registry, or null when `text` is not exactly the documented shape. */
export function parseInstalled(text: string): Installed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== 1 || !own(raw, 'engine') || !isObject(raw.pairs)) return null;
  let engine: Installed['engine'] = null;
  if (raw.engine !== null) {
    const e = raw.engine;
    if (!isObject(e) || typeof e.sha256 !== 'string' || !SHA.test(e.sha256) || !isSize(e.size)) return null;
    engine = { sha256: e.sha256, size: e.size };
  }
  const pairs: Record<string, InstalledPair> = {};
  for (const [key, p] of Object.entries(raw.pairs)) {
    if (!PAIR_KEY.test(key) || !isObject(p) || typeof p.version !== 'string' || !VERSION.test(p.version)) return null;
    if (!Array.isArray(p.files) || p.files.length === 0) return null;
    const files: InstalledFile[] = [];
    const names = new Set<string>();
    for (const f of p.files) {
      if (!isObject(f) || typeof f.name !== 'string' || !isFileName(f.name)) return null;
      if (typeof f.sha256 !== 'string' || !SHA.test(f.sha256) || !isSize(f.size) || names.has(f.name)) return null;
      names.add(f.name);
      files.push({ name: f.name, sha256: f.sha256, size: f.size });
    }
    pairs[key] = { version: p.version, files };
  }
  return { version: 1, engine, pairs };
}

/** `engine/<first 12 hex of the sha256>` under the root. */
export const engineDir = (root: string, sha256: string): string => `${root}/engine/${sha256.slice(0, 12)}`;
export const enginePath = (root: string, sha256: string): string => `${engineDir(root, sha256)}/${ENGINE_FILE}`;
export const pairRoot = (root: string, key: string): string => `${root}/models/${key}`;
export const pairDir = (root: string, key: string, version: string): string => `${pairRoot(root, key)}/${version}`;
export const modelPath = (root: string, key: string, version: string, name: string): string =>
  `${pairDir(root, key, version)}/${name}`;

const clone = (i: Installed): Installed => JSON.parse(JSON.stringify(i)) as Installed;
const clonePair = (p: InstalledPair): InstalledPair => ({ version: p.version, files: p.files.map((f) => ({ ...f })) });

/** The same `{name, sha256}` set (order aside). */
function sameFiles(a: readonly { name: string; sha256: string }[], b: readonly { name: string; sha256: string }[]): boolean {
  const ids = (fs: readonly { name: string; sha256: string }[]) => new Set(fs.map((f) => `${f.name}\n${f.sha256}`));
  const x = ids(a);
  const y = ids(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
}

export class InstalledStore {
  private readonly adapter: DataAdapter;
  private readonly root: string;
  private data: Installed | null = null;
  /** The first read, shared by every caller that asks before it lands. */
  private loading: Promise<Installed> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(adapter: DataAdapter, root: string) {
    this.adapter = adapter;
    this.root = root;
  }

  private get file(): string {
    return `${this.root}/${REGISTRY}`;
  }

  /** The registry as recorded (cached after the first read; a missing or corrupt file is empty). */
  private raw(): Promise<Installed> {
    if (this.data) return Promise.resolve(this.data);
    this.loading ??= this.readRegistry().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readRegistry(): Promise<Installed> {
    let parsed: Installed | null = null;
    if (await this.adapter.exists(this.file)) {
      parsed = parseInstalled(await this.adapter.read(this.file));
    } else if (await this.adapter.exists(`${this.file}.tmp`)) {
      // A write cut short between "remove main" and "rename": a tmp that parses is the newest copy.
      parsed = parseInstalled(await this.adapter.read(`${this.file}.tmp`));
    }
    this.data = parsed ?? emptyInstalled();
    return this.data;
  }

  private async fileOk(path: string, size: number): Promise<boolean> {
    try {
      const st = await this.adapter.stat(path);
      return !!st && st.type === 'file' && st.size === size;
    } catch {
      return false;
    }
  }

  private async pairOk(key: string, p: InstalledPair): Promise<boolean> {
    for (const f of p.files) {
      if (!(await this.fileOk(modelPath(this.root, key, p.version, f.name), f.size))) return false;
    }
    return true;
  }

  private async engineOk(e: NonNullable<Installed['engine']>): Promise<boolean> {
    return this.fileOk(enginePath(this.root, e.sha256), e.size);
  }

  /** What is installed and intact: entries whose files are missing or the wrong size are left out. */
  async load(): Promise<Installed> {
    const raw = await this.raw();
    const out = emptyInstalled();
    if (raw.engine && (await this.engineOk(raw.engine))) out.engine = { ...raw.engine };
    for (const [key, p] of Object.entries(raw.pairs)) {
      if (await this.pairOk(key, p)) out.pairs[key] = clonePair(p);
    }
    return out;
  }

  /**
   * Whether `key` is installed at `version`, intact. With `expected` (the catalog's files), the recorded
   * `{name, sha256}` set must also equal it: a pair recorded with other files (a catalog that changed a
   * file without a new version) is not installed, so a fresh download is offered.
   */
  async hasPair(key: string, version: string, expected?: readonly { name: string; sha256: string }[]): Promise<boolean> {
    const pairs = (await this.raw()).pairs;
    if (!own(pairs, key)) return false;
    const p = pairs[key];
    if (p.version !== version) return false;
    if (expected && !sameFiles(p.files, expected)) return false;
    return this.pairOk(key, p);
  }

  async hasEngine(sha256: string): Promise<boolean> {
    const e = (await this.raw()).engine;
    return !!e && e.sha256 === sha256 && (await this.engineOk(e));
  }

  /** The recorded entry for `key` (intact or not), for cleaning up an older version. */
  async entry(key: string): Promise<InstalledPair | null> {
    const raw = await this.raw();
    return own(raw.pairs, key) ? clonePair(raw.pairs[key]) : null;
  }

  async engineEntry(): Promise<Installed['engine']> {
    const e = (await this.raw()).engine;
    return e ? { ...e } : null;
  }

  /** Records `key` as installed (replacing an older entry). Call only after every file is verified and in place. */
  markPair(key: string, version: string, files: readonly InstalledFile[]): Promise<void> {
    const names = new Set(files.map((f) => f.name));
    const filesOk =
      files.length > 0 &&
      names.size === files.length &&
      files.every((f) => isFileName(f.name) && SHA.test(f.sha256) && isSize(f.size));
    if (!PAIR_KEY.test(key) || !VERSION.test(version) || !filesOk) {
      return Promise.reject(new Error(`invalid registry entry ${key}@${version}`));
    }
    return this.mutate((d) => {
      d.pairs[key] = { version, files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })) };
    });
  }

  markEngine(sha256: string, size: number): Promise<void> {
    if (!SHA.test(sha256) || !isSize(size)) return Promise.reject(new Error('invalid engine entry'));
    return this.mutate((d) => {
      d.engine = { sha256, size };
    });
  }

  /**
   * Deletes `key`'s folder (every version) and its entry. When it was the last pair, the engine goes
   * too, unless `keepEngine` (a download that needs it is running).
   */
  async removePair(key: string, opts: { keepEngine?: boolean } = {}): Promise<void> {
    if (!PAIR_KEY.test(key)) throw new Error(`invalid pair ${key}`);
    let engineGone: string | null = null;
    await this.mutate((d) => {
      delete d.pairs[key];
      if (!Object.keys(d.pairs).length && d.engine && !opts.keepEngine) {
        engineGone = d.engine.sha256;
        d.engine = null;
      }
    });
    // The registry no longer claims them, so a failure below only leaves unused bytes behind.
    await this.removeFolder(pairRoot(this.root, key));
    if (engineGone) await this.removeFolder(engineDir(this.root, engineGone));
  }

  /** Bytes per recorded pair (as recorded), sorted by key. */
  async sizes(): Promise<{ key: string; bytes: number }[]> {
    const raw = await this.raw();
    return Object.entries(raw.pairs)
      .map(([key, p]) => ({ key, bytes: p.files.reduce((s, f) => s + f.size, 0) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** The recorded engine's size, or null. */
  async engineSize(): Promise<number | null> {
    return (await this.raw()).engine?.size ?? null;
  }

  /**
   * Removes every download and the registry's entries for them (the engine too). Folders the registry
   * never listed go as well. Callers make sure no download is running.
   */
  async removeAll(): Promise<void> {
    await this.mutate((d) => {
      d.pairs = {};
      d.engine = null;
    });
    await this.removeFolder(`${this.root}/models`);
    await this.removeFolder(`${this.root}/engine`);
  }

  /**
   * Tidies what an interrupted download or write left behind (startup, while nothing downloads):
   * every `*.part` file; `installed.json.tmp` when `installed.json` exists; and the `engine/*` and
   * `models/<pair>/<version>` folders the registry doesn't list. When `installed.json` exists but
   * can't be read, no folder is touched (only `.part` files go). Runs between registry writes.
   * Returns what it removed.
   */
  sweep(): Promise<string[]> {
    const run = this.queue.then(() => this.sweepNow());
    this.queue = run.catch(() => {});
    return run;
  }

  private async sweepNow(): Promise<string[]> {
    const removed: string[] = [];
    if (!(await this.adapter.exists(this.root))) return removed;
    const gone = async (path: string, remove: () => Promise<void>) => {
      try {
        await remove();
        removed.push(path);
      } catch (e) {
        console.warn(`margin: could not remove ${path}`, e);
      }
    };
    const tmp = `${this.file}.tmp`;
    const mainExists = await this.adapter.exists(this.file);
    let registry: Installed | null = emptyInstalled();
    if (mainExists) registry = parseInstalled(await this.adapter.read(this.file));
    else if (await this.adapter.exists(tmp)) registry = parseInstalled(await this.adapter.read(tmp));
    if (mainExists && (await this.adapter.exists(tmp))) await gone(tmp, () => this.adapter.remove(tmp));

    const parts: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const { files, folders } = await this.adapter.list(dir);
      for (const f of files) if (f.endsWith('.part')) parts.push(f);
      for (const sub of folders) await walk(sub);
    };
    await walk(this.root);
    for (const p of parts) await gone(p, () => this.adapter.remove(p));

    if (!registry) return removed;
    const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    const folders = async (dir: string) => ((await this.adapter.exists(dir)) ? (await this.adapter.list(dir)).folders : []);
    const engineKeep = registry.engine?.sha256.slice(0, 12) ?? null;
    for (const dir of await folders(`${this.root}/engine`)) {
      if (name(dir) !== engineKeep) await gone(dir, () => this.removeFolder(dir));
    }
    for (const dir of await folders(`${this.root}/models`)) {
      const key = name(dir);
      const pair = own(registry.pairs, key) ? registry.pairs[key] : null;
      if (!pair) {
        await gone(dir, () => this.removeFolder(dir));
        continue;
      }
      for (const v of await folders(dir)) {
        if (name(v) !== pair.version) await gone(v, () => this.removeFolder(v));
      }
    }
    return removed;
  }

  /** Removes a folder under the root and everything in it (a no-op when absent). */
  async removeFolder(path: string): Promise<void> {
    if (!path.startsWith(`${this.root}/`) || path.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new Error(`refusing to remove ${path}`);
    }
    if (!(await this.adapter.exists(path))) return;
    await this.adapter.rmdir(path, true);
  }

  private mutate(fn: (d: Installed) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const next = clone(await this.raw());
      fn(next);
      await this.write(next);
      this.data = next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(d: Installed): Promise<void> {
    const tmp = `${this.file}.tmp`;
    if (!(await this.adapter.exists(this.root))) await this.adapter.mkdir(this.root);
    await this.adapter.write(tmp, `${JSON.stringify(d, null, 2)}\n`);
    if (await this.adapter.exists(this.file)) await this.adapter.remove(this.file);
    await this.adapter.rename(tmp, this.file);
  }
}

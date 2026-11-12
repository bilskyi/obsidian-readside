// The plugin's TranslateHost (src/translate/types.ts): detection and routing from the shared core,
// downloads into `<configDir>/plugins/margin-reader/translation/`, and the Bergamot client for the
// translating itself.
//
//  - translate(): detect (when `from` is auto) → route (direct, or via English) → if the engine or a
//    leg isn't installed, a download offer; else load the legs into the client and translate.
//  - download(): one job per pair; a second download of the same pair joins it. Underneath, the
//    engine and each leg are their own shared units, so two pairs that need the same files (the
//    engine, or uk→en for both uk→en and uk→de) fetch them once. A unit that fails or is cancelled
//    removes what it wrote; only a complete, verified unit is recorded in installed.json.
//  - Model and engine bytes are read from disk on every call (the client transfers them to the
//    worker, which detaches them), never cached here.
//  - translateWord() (⌥-hover) never downloads: a translation only when the pair is installed, else
//    why not (not installed, downloading now, unavailable); results are kept
//    in a 500-entry LRU per pair.
import type { DataAdapter } from 'obsidian';
import type { ModelFile } from '../../../src/translate/bergamot/protocol';
import type { BergamotClient } from '../../../src/translate/bergamot/BergamotClient';
import { ENGINE, type CatalogFile } from '../../../src/translate/catalog';
import { detectLanguage } from '../../../src/translate/detect';
import { LANGUAGES, languageName } from '../../../src/translate/languages';
import { Lru } from '../../../src/translate/lru';
import { offerFor, pairKey, route, totalBytes, type Leg } from '../../../src/translate/planPair';
import { downloadingText } from '../../../src/translate/format';
import type {
  DownloadOffer,
  DownloadProgress,
  TranslateHost,
  TranslateOutcome,
  TranslateRequest,
  WordOutcome,
} from '../../../src/translate/types';
import { abortError, downloadFile, isAbortError, messageOf, sha256Hex, type DownloadDeps, type Fetcher } from './downloads';
import { InstalledStore, engineDir, enginePath, modelPath, pairDir } from './installed';
import { SharedJobs } from './shared';

export const WORD_CACHE_SIZE = 500;
/** Below this length the selection is detected together with its page context. */
export const DETECT_ALONE_MIN = 40;
export const PAIR_LANGS: readonly string[] = LANGUAGES.map((l) => l.code);
const CODES = new Set(PAIR_LANGS);

export const NOT_AVAILABLE = "This pair isn't available offline";
export const HOST_CLOSED = 'Translation was shut down';
export const ENGINE_MISSING = 'The translation engine is not installed';
export const STILL_DOWNLOADING = 'A download is still running; try again when it has finished';
export const ENGINE_DAMAGED =
  'The translation engine file is damaged; remove the downloaded languages in Settings → Translation and download again';
export const PAIR_REMOVED = 'This language pair was removed while translating. Translate again to download it.';

export type TranslateClient = Pick<BergamotClient, 'ensureModel' | 'translate' | 'dispose'>;

export interface HostDeps {
  adapter: DataAdapter;
  /** `<configDir>/plugins/margin-reader/translation` */
  root: string;
  fetcher: Fetcher;
  settings: () => { target: string; hover: boolean };
  saveTarget: (code: string) => void;
  /** Owned by the host from here on: dispose() disposes it. */
  client: TranslateClient;
  notice: (message: string) => void;
  /**
   * A Notice that stays and can change (Obsidian: `new Notice(message, 0)`), for a download whose card
   * closed. Without it, such a download carries on with no progress shown.
   */
  progressNotice?: (message: string) => ProgressNotice;
  /** Defaults to crypto.subtle (tests pass a fake). */
  sha256?: (b: ArrayBuffer) => Promise<string>;
  /** Folder work already running when the host is made (the plugin's light startup sweep): downloads wait for it. */
  maintenance?: Promise<void>;
}

export interface ProgressNotice {
  setMessage(message: string): unknown;
  hide(): void;
}

interface Unit {
  key: string;
  bytes: number;
  run: (signal: AbortSignal, emit: (received: number) => void) => Promise<void>;
}

/**
 * The installed engine's wasm, read from disk on every call (a fresh buffer each time, as
 * BergamotClient's `wasm` dep needs). Rejects when the catalog's engine isn't installed and intact, or
 * its bytes don't hash to the catalog's sha256.
 */
export async function readEngineWasm(
  adapter: DataAdapter,
  root: string,
  sha256: (b: ArrayBuffer) => Promise<string> = sha256Hex,
): Promise<ArrayBuffer> {
  const store = new InstalledStore(adapter, root);
  if (!(await store.hasEngine(ENGINE.file.sha256))) throw new Error(ENGINE_MISSING);
  let bytes: ArrayBuffer;
  try {
    bytes = await adapter.readBinary(enginePath(root, ENGINE.file.sha256));
  } catch {
    throw new Error(ENGINE_MISSING); // removed between the check and the read
  }
  if (bytes.byteLength !== ENGINE.file.size) throw new Error(ENGINE_MISSING);
  // Once per worker start (BergamotClient asks for the wasm only then): the bytes compiled are the pinned ones.
  if ((await sha256(bytes)) !== ENGINE.file.sha256) throw new Error(ENGINE_DAMAGED);
  return bytes;
}

export class ObsidianTranslateHost implements TranslateHost {
  private readonly deps: HostDeps;
  private readonly store: InstalledStore;
  private readonly dl: DownloadDeps;
  private readonly pairJobs = new SharedJobs<void, DownloadProgress>();
  private readonly units = new SharedJobs<void, number>();
  /** Every leg each running pair download goes through, installed or still queued. */
  private readonly needs = new Map<symbol, string[]>();
  /** The legs of each pair download asked for (counted from the call, before its job has started). */
  private readonly pairLegs = new Map<string, string[]>();
  /** ⌥-hover results per pair, with the legs they went through (so removing a leg drops them). */
  private readonly words = new Map<string, { legs: string[]; lru: Lru<string, string> }>();
  private disposed = false;
  /**
   * Folder work in progress (a sweep, removePair, removeAll), chained: a download waits for all of it
   * before it looks at what is installed or writes anything.
   */
  private maintenance: Promise<void> | null = null;
  /** The sweep while it runs (a second call joins it). */
  private sweeping: Promise<void> | null = null;
  /** Downloads carried on after their card closed: the host's own joiner and its progress Notice. */
  private readonly backgrounded = new Map<string, { ctl: AbortController; notice: ProgressNotice | null }>();

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.store = new InstalledStore(deps.adapter, deps.root);
    this.dl = { adapter: deps.adapter, root: deps.root, fetcher: deps.fetcher, sha256: deps.sha256 ?? sha256Hex };
    const startup = deps.maintenance;
    if (startup) void this.maintain(() => startup).catch(() => {});
  }

  /** Runs `op` behind the maintenance gate (after any earlier maintenance); downloads wait for it. */
  private maintain<T>(op: () => Promise<T>): Promise<T> {
    const run = (this.maintenance ?? Promise.resolve()).then(op);
    const gate = run.then(
      () => undefined,
      () => undefined,
    );
    this.maintenance = gate;
    void gate.then(() => {
      if (this.maintenance === gate) this.maintenance = null;
    });
    return run;
  }

  target(): string {
    return this.deps.settings().target;
  }

  languages(): readonly { code: string; name: string }[] {
    return LANGUAGES.map(({ code, name }) => ({ code, name }));
  }

  hoverEnabled(): boolean {
    return this.deps.settings().hover;
  }

  setDefaultTarget(code: string): void {
    if (CODES.has(code)) this.deps.saveTarget(code);
  }

  async translate(req: TranslateRequest): Promise<TranslateOutcome> {
    this.assertOpen();
    const to = req.to ?? this.target();
    const explicit = req.from && req.from !== 'auto' ? req.from : null;
    let from = explicit;
    if (!from) {
      const text = req.text.length >= DETECT_ALONE_MIN ? req.text : `${req.context ?? ''} ${req.text}`;
      from = detectLanguage(text, PAIR_LANGS);
    }
    if (!CODES.has(to)) return { kind: 'unsupported', from, to };
    if (!from) return { kind: 'unsupported', from: null, to };
    const r = route(from, to);
    if (r.kind === 'same') return { kind: 'same', lang: to };
    if (r.kind === 'unsupported') return { kind: 'unsupported', from, to };
    const offer = await this.offer(r.legs);
    if (offer) return { kind: 'needsDownload', offer };
    const keys = await this.prepare(r.legs);
    const [text] = await this.deps.client.translate(keys, [req.text], req.signal);
    return { kind: 'done', text, from, to };
  }

  async translateWord(word: string, from: string, to: string, signal?: AbortSignal): Promise<WordOutcome> {
    if (this.disposed) return { kind: 'unavailable' };
    const w = word.trim();
    if (!w) return { kind: 'unavailable' };
    const r = route(from, to);
    if (r.kind !== 'ok') return { kind: 'unavailable' };
    const key = pairKey(from, to);
    const cached = this.words.get(key)?.lru.get(w);
    if (cached !== undefined) return { kind: 'done', text: cached };
    if (await this.offer(r.legs)) {
      const busy = this.pairJobs.has(key) || r.legs.some((l) => this.downloading(pairKey(l.from, l.to)));
      return { kind: busy ? 'downloading' : 'notInstalled' };
    }
    const keys = await this.prepare(r.legs);
    const [out] = await this.deps.client.translate(keys, [w], signal);
    let entry = this.words.get(key);
    if (!entry) this.words.set(key, (entry = { legs: keys, lru: new Lru<string, string>(WORD_CACHE_SIZE) }));
    entry.lru.set(w, out);
    return { kind: 'done', text: out };
  }

  download(
    offer: DownloadOffer,
    opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(HOST_CLOSED));
    const r = route(offer.from, offer.to);
    if (r.kind !== 'ok') return Promise.reject(new Error(NOT_AVAILABLE));
    const legs = r.legs;
    const key = pairKey(offer.from, offer.to);
    this.pairLegs.set(key, legs.map((l) => pairKey(l.from, l.to)));
    const joined = this.pairJobs.join(key, (signal, emit) => this.runPair(offer.from, offer.to, legs, signal, emit), opts);
    // A card shows this download again: it takes over from the background Notice (joined first, so the
    // download never loses its last joiner in between).
    if (!opts.signal?.aborted) this.foreground(key);
    return joined;
  }

  isDownloading(from: string, to: string): boolean {
    return this.pairJobs.has(pairKey(from, to));
  }

  /**
   * The card showing this pair's download closed: the download carries on, joined by the host itself,
   * with its progress in a Notice until it ends; it then says how it ended (the only place that does).
   */
  background(offer: DownloadOffer): void {
    const key = pairKey(offer.from, offer.to);
    const r = route(offer.from, offer.to);
    if (this.disposed || r.kind !== 'ok' || this.backgrounded.has(key) || !this.pairJobs.has(key)) return;
    const legs = r.legs;
    const ctl = new AbortController();
    const title = `${languageName(offer.from)} → ${languageName(offer.to)}`;
    const notice = this.deps.progressNotice?.(`${title}: Downloading…`) ?? null;
    const entry = { ctl, notice };
    this.backgrounded.set(key, entry);
    this.pairJobs
      .join(key, (signal, emit) => this.runPair(offer.from, offer.to, legs, signal, emit), {
        signal: ctl.signal,
        onProgress: (p) => notice?.setMessage(`${title}: ${downloadingText(p)}`),
      })
      // How it ended is said here, and only here: with no card left to show it. A card that took the
      // download back (foreground) or dispose removed this entry first, so they stay quiet; a card that
      // stays open shows the result or the error itself.
      .then(
        () => {
          if (this.backgrounded.get(key) === entry) this.deps.notice(`${title} is downloaded. Translation now works offline.`);
        },
        (e: unknown) => {
          if (this.backgrounded.get(key) === entry && !ctl.signal.aborted && !isAbortError(e)) {
            this.deps.notice(`${title}: ${messageOf(e)}`);
          }
        },
      )
      .finally(() => {
        notice?.hide();
        if (this.backgrounded.get(key) === entry) this.backgrounded.delete(key);
      });
  }

  private foreground(key: string): void {
    const bg = this.backgrounded.get(key);
    if (!bg) return;
    this.backgrounded.delete(key);
    bg.notice?.hide();
    bg.ctl.abort();
  }

  /** Recorded pairs and their sizes, for Settings → Translation. */
  installedSizes(): Promise<{ key: string; bytes: number }[]> {
    return this.store.sizes();
  }

  engineSize(): Promise<number | null> {
    return this.store.engineSize();
  }

  /**
   * Whether a download that writes or needs `key`'s files (or any download, without a key) is
   * running. A leg queued behind the engine, or one a pivot pair goes through, counts.
   */
  downloading(key?: string): boolean {
    if (key === undefined) return this.pairJobs.keys().length > 0 || this.units.keys().length > 0 || this.needs.size > 0;
    return (
      this.units.has(`leg:${key}`) ||
      [...this.needs.values()].some((keys) => keys.includes(key)) ||
      [...this.pairLegs].some(([pair, legs]) => this.pairJobs.has(pair) && legs.includes(key))
    );
  }

  /**
   * Removes a downloaded pair (and the engine with the last one, unless a download still needs it).
   * Refused while that pair is downloading.
   */
  async removePair(key: string): Promise<void> {
    if (this.downloading(key)) throw new Error(`${key} is still downloading`);
    await this.maintain(() => this.store.removePair(key, { keepEngine: this.downloading() }));
    for (const [k, entry] of [...this.words]) {
      if (entry.legs.includes(key)) this.words.delete(k);
    }
  }

  /**
   * Removes every downloaded pair and the engine. Refused while anything downloads.
   */
  async removeAll(): Promise<void> {
    if (this.downloading()) throw new Error(STILL_DOWNLOADING);
    await this.maintain(() => this.store.removeAll());
    this.words.clear();
  }

  /**
   * Tidies what an interrupted download left behind (InstalledStore.sweep). Skipped while anything
   * downloads; a download that starts meanwhile waits for it. Never rejects.
   */
  sweep(): Promise<void> {
    if (this.disposed || this.downloading()) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    const run = this.maintain(() => this.store.sweep())
      .then(
        () => undefined,
        (e) => console.warn('margin: could not tidy the translation folder', e),
      )
      .finally(() => {
        if (this.sweeping === run) this.sweeping = null;
      });
    this.sweeping = run;
    return run;
  }

  /** Cancels running downloads (their partial files are removed) and shuts the engine down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of [...this.backgrounded.keys()]) this.foreground(key);
    this.pairJobs.abortAll();
    this.units.abortAll();
    this.words.clear();
    this.deps.client.dispose();
  }

  // -------------------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.disposed) throw new Error(HOST_CLOSED);
  }

  private async offer(legs: readonly Leg[]): Promise<DownloadOffer | null> {
    const engine = await this.store.hasEngine(ENGINE.file.sha256);
    const have = new Set<string>();
    for (const l of legs) {
      const key = pairKey(l.from, l.to);
      if (await this.store.hasPair(key, l.pair.version, l.pair.files)) have.add(key);
    }
    return offerFor(legs, (k) => have.has(k), engine);
  }

  /** Registers (and loads) each leg in the client; its bytes are re-read from disk on every load. */
  private async prepare(legs: readonly Leg[]): Promise<string[]> {
    const keys: string[] = [];
    for (const l of legs) {
      const key = pairKey(l.from, l.to);
      const { version, files } = l.pair;
      await this.deps.client.ensureModel(key, l.from, l.to, () => this.readModel(key, version, files));
      keys.push(key);
    }
    return keys;
  }

  private async readModel(key: string, version: string, files: readonly CatalogFile[]): Promise<ModelFile[]> {
    const out: ModelFile[] = [];
    for (const f of files) {
      let bytes: ArrayBuffer;
      try {
        bytes = await this.deps.adapter.readBinary(modelPath(this.deps.root, key, version, f.name));
      } catch (e) {
        // Removed (Settings → Translation) between the check and the load: say so, not the adapter's ENOENT.
        if (!(await this.store.hasPair(key, version, files))) throw new Error(PAIR_REMOVED);
        throw e;
      }
      if (bytes.byteLength !== f.size) {
        throw new Error(`${key}: ${f.name} is damaged; remove the language pair and download it again`);
      }
      out.push({ type: f.type, name: f.name, bytes });
    }
    return out;
  }

  private async runPair(
    from: string,
    to: string,
    legs: readonly Leg[],
    signal: AbortSignal,
    emit: (p: DownloadProgress) => void,
  ): Promise<void> {
    const job = Symbol(pairKey(from, to));
    this.needs.set(job, legs.map((l) => pairKey(l.from, l.to)));
    try {
      // How it ends is the card's to show, or background()'s Notice once no card is left.
      await this.runUnits(legs, signal, emit);
    } finally {
      this.needs.delete(job);
    }
  }

  private async runUnits(
    legs: readonly Leg[],
    signal: AbortSignal,
    emit: (p: DownloadProgress) => void,
  ): Promise<void> {
    while (this.maintenance) await this.maintenance;
    if (signal.aborted) throw new DOMException('The download was cancelled', 'AbortError');
    const units: Unit[] = [];
    if (!(await this.store.hasEngine(ENGINE.file.sha256))) units.push(this.engineUnit());
    for (const l of legs) {
      if (!(await this.store.hasPair(pairKey(l.from, l.to), l.pair.version, l.pair.files))) units.push(this.legUnit(l));
    }
    if (!units.length) return;
    const total = units.reduce((s, u) => s + u.bytes, 0);
    const got = new Map<string, number>();
    let last = -1;
    const report = () => {
      const received = Math.min(total, [...got.values()].reduce((s, n) => s + n, 0));
      if (received <= last) return;
      last = received;
      emit({ received, total });
    };
    emit({ received: 0, total });
    last = 0;
    for (const u of units) {
      await this.units.join(u.key, u.run, {
        signal,
        onProgress: (n) => {
          got.set(u.key, n);
          report();
        },
      });
      got.set(u.key, u.bytes);
      report();
    }
  }

  private engineUnit(): Unit {
    const { file } = ENGINE;
    return {
      key: 'engine',
      bytes: file.size,
      run: async (signal, emit) => {
        if (await this.store.hasEngine(file.sha256)) return;
        let got = 0;
        try {
          await downloadFile(this.dl, file, enginePath(this.deps.root, file.sha256), (n) => emit((got += n)), signal);
          const prev = await this.store.engineEntry();
          // Cancelled after the last byte: nothing is recorded (the catch removes what was written).
          if (signal.aborted) throw abortError();
          await this.store.markEngine(file.sha256, file.size);
          if (prev && prev.sha256 !== file.sha256) {
            await this.store.removeFolder(engineDir(this.deps.root, prev.sha256)).catch(() => {});
          }
        } catch (e) {
          if (!(await this.store.hasEngine(file.sha256))) {
            await this.store.removeFolder(engineDir(this.deps.root, file.sha256)).catch(() => {});
          }
          throw e;
        }
      },
    };
  }

  private legUnit(l: Leg): Unit {
    const key = pairKey(l.from, l.to);
    const { version, files } = l.pair;
    return {
      key: `leg:${key}`,
      bytes: totalBytes(files),
      run: async (signal, emit) => {
        if (await this.store.hasPair(key, version, files)) return;
        let got = 0;
        try {
          for (const f of files) {
            await downloadFile(this.dl, f, modelPath(this.deps.root, key, version, f.name), (n) => emit((got += n)), signal);
          }
          const prev = await this.store.entry(key);
          if (signal.aborted) throw abortError();
          await this.store.markPair(key, version, files);
          if (prev && prev.version !== version) {
            await this.store.removeFolder(pairDir(this.deps.root, key, prev.version)).catch(() => {});
          }
        } catch (e) {
          // Files of this leg that did arrive are not recorded, so they go too.
          if (!(await this.store.hasPair(key, version, files))) {
            await this.store.removeFolder(pairDir(this.deps.root, key, version)).catch(() => {});
          }
          throw e;
        }
      },
    };
  }
}

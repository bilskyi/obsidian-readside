import { describe, expect, it, vi } from 'vitest';
import { ENGINE } from '../../src/translate/catalog';
import {
  CHECKSUM_MISMATCH,
  downloadFile,
  isPinned,
  nodeFetcher,
  requestUrlFetcher,
  sha256Hex,
  type DownloadDeps,
  type HttpsLike,
} from '../src/translate/downloads';
import { FakeFetcher, SMALL, TROOT, TestAdapter, bodyOf, fakeSha256 } from './translateFakes';

const DEST = `${TROOT}/models/x/1/${SMALL.name}`;

function setup(over: Partial<DownloadDeps> = {}) {
  const adapter = new TestAdapter();
  const fetcher = new FakeFetcher();
  const deps: DownloadDeps = { adapter: adapter as never, root: TROOT, fetcher, sha256: fakeSha256, ...over };
  return { adapter, fetcher, deps };
}

describe('downloadFile', () => {
  it('writes the body to <dest>.part, verifies it, renames it to <dest>; progress sums to the size', async () => {
    const { adapter, deps } = setup();
    const seen: number[] = [];
    await downloadFile(deps, SMALL, DEST, (n) => seen.push(n));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.reduce((s, n) => s + n, 0)).toBe(SMALL.size);
    const ops = adapter.calls.filter((c) => /^(writeBinary|rename|remove) /.test(c));
    expect(ops).toEqual([`writeBinary ${DEST}.part`, `rename ${DEST}.part`]);
    expect(adapter.files.has(`${DEST}.part`)).toBe(false);
    expect(new Uint8Array(adapter.files.get(DEST) as ArrayBuffer)).toEqual(bodyOf(SMALL));
  });

  it('replaces an existing <dest>', async () => {
    const { adapter, deps } = setup();
    await adapter.mkdir(`${TROOT}/models/x/1`);
    adapter.files.set(DEST, new ArrayBuffer(3));
    await downloadFile(deps, SMALL, DEST, () => {});
    expect((adapter.files.get(DEST) as ArrayBuffer).byteLength).toBe(SMALL.size);
  });

  it('on a checksum mismatch removes the .part and rejects', async () => {
    const { adapter, fetcher, deps } = setup();
    fetcher.serve(SMALL.url, { body: bodyOf(SMALL, 'tampered') });
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(CHECKSUM_MISMATCH);
    expect(adapter.calls).toContain(`writeBinary ${DEST}.part`);
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('really hashes with crypto.subtle by default helper (fake bytes never match the pin)', async () => {
    const { adapter, deps } = setup({ sha256: sha256Hex });
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(CHECKSUM_MISMATCH);
    expect(adapter.under(TROOT)).toEqual([]);
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('abort while fetching rejects with an AbortError and leaves nothing', async () => {
    const { adapter, deps } = setup();
    const ctl = new AbortController();
    const p = downloadFile(deps, SMALL, DEST, () => ctl.abort(), ctl.signal);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('abort after the .part is written removes it', async () => {
    const ctl = new AbortController();
    const { adapter, deps } = setup({
      sha256: async (b) => {
        ctl.abort();
        return fakeSha256(b);
      },
    });
    await expect(downloadFile(deps, SMALL, DEST, () => {}, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.calls).toContain(`writeBinary ${DEST}.part`);
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('an already aborted signal makes no request', async () => {
    const { fetcher, deps } = setup();
    const ctl = new AbortController();
    ctl.abort();
    await expect(downloadFile(deps, SMALL, DEST, () => {}, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.total()).toBe(0);
  });

  it('a non-200 response rejects "The download failed: HTTP <n>" and writes nothing', async () => {
    const { adapter, fetcher, deps } = setup();
    fetcher.serve(SMALL.url, { status: 503 });
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow('The download failed: HTTP 503');
    expect(adapter.calls.some((c) => c.startsWith('writeBinary'))).toBe(false);
  });

  it('a network error rejects "The download failed: <reason>"', async () => {
    const { adapter, fetcher, deps } = setup();
    fetcher.serve(SMALL.url, { error: new Error('the connection was interrupted'), failAfter: 0 });
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow('The download failed: the connection was interrupted');
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('refuses a URL that is not a pinned catalog file before any request', async () => {
    const { fetcher, deps } = setup();
    const evil = [
      { ...SMALL, url: SMALL.url.replace('firefox-settings-attachments.cdn.mozilla.net', 'evil.example') },
      { ...SMALL, url: SMALL.url.replace('https:', 'http:') },
      { ...SMALL, sha256: 'f'.repeat(64) },
      { ...SMALL, size: SMALL.size + 1 },
    ];
    for (const f of evil) {
      expect(isPinned(f)).toBe(false);
      await expect(downloadFile(deps, f, DEST, () => {})).rejects.toThrow(/not a pinned catalog file/);
    }
    expect(fetcher.total()).toBe(0);
    expect(isPinned(SMALL)).toBe(true);
    expect(isPinned(ENGINE.file)).toBe(true);
  });

  it('refuses a destination outside the translation folder', async () => {
    const { fetcher, deps } = setup();
    for (const d of ['.obsidian/plugins/margin-reader/data.json', `${TROOT}/../data.json`, `${TROOT}/models//x`]) {
      await expect(downloadFile(deps, SMALL, d, () => {})).rejects.toThrow(/outside the translation folder/);
    }
    expect(fetcher.total()).toBe(0);
  });

  it('a body shorter than the catalog size fails without writing', async () => {
    const { adapter, fetcher, deps } = setup();
    fetcher.serve(SMALL.url, { body: bodyOf(SMALL).subarray(0, 1000) });
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(/ended early \(1000 of/);
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('a body longer than the catalog size is cut off', async () => {
    const { adapter, fetcher, deps } = setup();
    const big = new Uint8Array(SMALL.size + 5);
    big.set(bodyOf(SMALL));
    fetcher.serve(SMALL.url, { body: big });
    fetcher.chunk = SMALL.size; // the overflow arrives in the second chunk
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(/larger than the expected/);
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('a failed write (disk full) removes the .part and says so', async () => {
    const { adapter, deps } = setup();
    adapter.failOn('writeBinary', `${DEST}.part`, 1, new Error('ENOSPC: no space left on device'));
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(
      `The download failed: could not save ${SMALL.name} (ENOSPC: no space left on device)`,
    );
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('a failed rename removes the .part', async () => {
    const { adapter, deps } = setup();
    adapter.failOn('rename', `${DEST}.part`);
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(/could not save/);
    expect(adapter.under(TROOT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

class Em {
  handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  on(e: string, cb: (...a: unknown[]) => void) {
    (this.handlers[e] ??= []).push(cb);
    return this;
  }
  emit(e: string, ...a: unknown[]) {
    for (const cb of this.handlers[e] ?? []) cb(...a);
  }
}

interface Script {
  status?: number;
  location?: string;
  chunks?: Uint8Array[];
  /** request error before any response */
  error?: { code?: string; message: string };
  /** never answer (for the stall timeout) */
  hang?: boolean;
  /** end with res.complete === false */
  incomplete?: boolean;
  /** never connect: only the socket timeout from `options.timeout` fires ('timeout' event) */
  connectHang?: boolean;
}

class FakeHttps implements HttpsLike {
  requests: string[] = [];
  destroyed = 0;
  resumed = 0;
  scripts = new Map<string, Script>();
  options: Record<string, unknown>[] = [];
  get(url: string, _opts: Record<string, unknown>, cb: (res: never) => void) {
    this.requests.push(url);
    this.options.push(_opts);
    const s = this.scripts.get(url) ?? { status: 404 };
    const req = new Em() as Em & { setTimeout: (ms: number, f: () => void) => void; destroy: (e?: unknown) => void };
    let dead = false;
    req.destroy = () => {
      dead = true;
      this.destroyed++;
    };
    req.setTimeout = (ms, f) => {
      if (s.hang) setTimeout(() => !dead && f(), ms);
    };
    if (s.connectHang && typeof _opts.timeout === 'number') setTimeout(() => !dead && req.emit('timeout'), _opts.timeout);
    setTimeout(async () => {
      if (dead || s.hang || s.connectHang) return;
      if (s.error) {
        req.emit('error', Object.assign(new Error(s.error.message), { code: s.error.code }));
        return;
      }
      const res = new Em() as Em & { statusCode: number; headers: Record<string, string>; complete: boolean; resume: () => void; destroy: () => void };
      res.statusCode = s.status ?? 200;
      res.headers = s.location ? { location: s.location } : {};
      res.complete = false;
      res.resume = () => {
        this.resumed++;
      };
      res.destroy = () => {};
      cb(res as never);
      for (const c of s.chunks ?? []) {
        await new Promise((r) => setTimeout(r, 0));
        if (dead) return;
        res.emit('data', c);
      }
      await new Promise((r) => setTimeout(r, 0));
      if (dead) return;
      res.complete = !s.incomplete;
      res.emit('end');
    }, 0);
    return req;
  }
}

const URL0 = SMALL.url;
const SAME_HOST = 'https://firefox-settings-attachments.cdn.mozilla.net/other/path.bin';

function collect() {
  const got: number[] = [];
  return { got, onChunk: (c: Uint8Array) => got.push(...c) };
}

describe('nodeFetcher', () => {
  it('is null without https, and loads it from window.require when present', () => {
    expect(nodeFetcher(null)).toBeNull();
    const g = globalThis as { require?: unknown };
    const before = g.require;
    try {
      g.require = undefined;
      expect(nodeFetcher()).toBeNull();
      const fake = new FakeHttps();
      g.require = (id: string) => (id === 'https' ? fake : undefined);
      expect(nodeFetcher()).not.toBeNull();
    } finally {
      g.require = before;
    }
  });

  it('streams a 200 body chunk by chunk', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 200, chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] });
    const { got, onChunk } = collect();
    await expect(nodeFetcher(https)!.get(URL0, onChunk)).resolves.toEqual({ status: 200 });
    expect(got).toEqual([1, 2, 3]);
  });

  it('a non-200 resolves with its status, drains the body and delivers nothing', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 404, chunks: [new Uint8Array([9])] });
    const { got, onChunk } = collect();
    await expect(nodeFetcher(https)!.get(URL0, onChunk)).resolves.toEqual({ status: 404 });
    expect(got).toEqual([]);
    expect(https.resumed).toBe(1);
  });

  it('follows a redirect on the pinned host', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 302, location: '/other/path.bin' });
    https.scripts.set(SAME_HOST, { status: 200, chunks: [new Uint8Array([7])] });
    const { got, onChunk } = collect();
    await expect(nodeFetcher(https)!.get(URL0, onChunk)).resolves.toEqual({ status: 200 });
    expect(https.requests).toEqual([URL0, SAME_HOST]);
    expect(got).toEqual([7]);
  });

  it('refuses a redirect to another host or to http, without requesting it', async () => {
    for (const location of ['https://evil.example/x.bin', 'http://firefox-settings-attachments.cdn.mozilla.net/x.bin']) {
      const https = new FakeHttps();
      https.scripts.set(URL0, { status: 301, location });
      await expect(nodeFetcher(https)!.get(URL0, () => {})).rejects.toThrow(/not the pinned download host/);
      expect(https.requests).toEqual([URL0]);
    }
  });

  it('stops after 3 redirects', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 302, location: SAME_HOST });
    https.scripts.set(SAME_HOST, { status: 302, location: SAME_HOST });
    await expect(nodeFetcher(https)!.get(URL0, () => {})).rejects.toThrow('too many redirects (more than 3)');
    expect(https.requests).toHaveLength(4);
  });

  it('names offline, refused, reset and certificate failures', async () => {
    const cases: [string, RegExp][] = [
      ['ENOTFOUND', /you seem to be offline/],
      ['EAI_AGAIN', /you seem to be offline/],
      ['ECONNREFUSED', /could not connect to firefox-settings-attachments/],
      ['ECONNRESET', /the connection was interrupted/],
      ['CERT_HAS_EXPIRED', /certificate .* could not be verified/],
    ];
    for (const [code, re] of cases) {
      const https = new FakeHttps();
      https.scripts.set(URL0, { error: { code, message: `getaddrinfo ${code}` } });
      await expect(nodeFetcher(https)!.get(URL0, () => {})).rejects.toThrow(re);
    }
  });

  it('times out when no data arrives and destroys the request', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { hang: true });
    await expect(nodeFetcher(https, { stallMs: 20 })!.get(URL0, () => {})).rejects.toThrow(
      /the connection timed out \(no data for 0 s\)/,
    );
    expect(https.destroyed).toBe(1);
  });

  it('a connection that ends early is an error, not a short success', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 200, chunks: [new Uint8Array([1])], incomplete: true });
    await expect(nodeFetcher(https)!.get(URL0, () => {})).rejects.toThrow('the connection was interrupted');
  });

  it('abort mid-stream rejects with an AbortError and destroys the request', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 200, chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])] });
    const ctl = new AbortController();
    const seen: number[] = [];
    const p = nodeFetcher(https)!.get(URL0, (c) => {
      seen.push(...c);
      ctl.abort();
    }, ctl.signal);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(https.destroyed).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1]);
  });

  it('through downloadFile: offline gives a clear error and leaves no files', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } });
    const adapter = new TestAdapter();
    const deps: DownloadDeps = { adapter: adapter as never, root: TROOT, fetcher: nodeFetcher(https)!, sha256: fakeSha256 };
    await expect(downloadFile(deps, SMALL, DEST, () => {})).rejects.toThrow(
      'The download failed: you seem to be offline (could not look up firefox-settings-attachments.cdn.mozilla.net)',
    );
    expect(adapter.under(TROOT)).toEqual([]);
  });

  it('through downloadFile: a full streamed download lands verified', async () => {
    const https = new FakeHttps();
    const body = bodyOf(SMALL);
    https.scripts.set(URL0, { status: 200, chunks: [body.subarray(0, 100_000), body.subarray(100_000)] });
    const adapter = new TestAdapter();
    const deps: DownloadDeps = { adapter: adapter as never, root: TROOT, fetcher: nodeFetcher(https)!, sha256: fakeSha256 };
    const seen: number[] = [];
    await downloadFile(deps, SMALL, DEST, (n) => seen.push(n));
    expect(seen).toEqual([100_000, SMALL.size - 100_000]);
    expect(adapter.under(TROOT)).toEqual([DEST]);
  });
});

describe('nodeFetcher: T4 review', () => {
  it('asks https for a socket timeout and certificate checks', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 200, chunks: [new Uint8Array([1])] });
    await nodeFetcher(https, { stallMs: 1234 })!.get(URL0, () => {});
    expect(https.options).toEqual([{ timeout: 1234, rejectUnauthorized: true }]);
  });

  it('a stalled connect times out through the request timeout event and destroys the request', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { connectHang: true });
    await expect(nodeFetcher(https, { stallMs: 20 })!.get(URL0, () => {})).rejects.toThrow(/the connection timed out/);
    expect(https.destroyed).toBe(1);
  });

  it('refuses a redirect to another port on the pinned host, without requesting it', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 302, location: 'https://firefox-settings-attachments.cdn.mozilla.net:8443/x.bin' });
    await expect(nodeFetcher(https)!.get(URL0, () => {})).rejects.toThrow(/refused a redirect to https:\/\/firefox-settings-attachments\.cdn\.mozilla\.net:8443/);
    expect(https.requests).toEqual([URL0]);
  });

  it('refuses a redirect carrying credentials, without requesting it or repeating them', async () => {
    const https = new FakeHttps();
    https.scripts.set(URL0, { status: 307, location: 'https://user:s3cret@firefox-settings-attachments.cdn.mozilla.net/x.bin' });
    const err = await nodeFetcher(https)!.get(URL0, () => {}).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/not the pinned download host/);
    expect(err?.message).not.toMatch(/s3cret|user/);
    expect(https.requests).toEqual([URL0]);
  });
});

describe('requestUrlFetcher', () => {
  it('delivers a 200 body as one chunk, without throwing on HTTP errors', async () => {
    const request = vi.fn(async () => ({ status: 200, arrayBuffer: new Uint8Array([4, 5]).buffer }) as never);
    const { got, onChunk } = collect();
    await expect(requestUrlFetcher(request).get(URL0, onChunk)).resolves.toEqual({ status: 200 });
    expect(got).toEqual([4, 5]);
    expect(request).toHaveBeenCalledWith({ url: URL0, method: 'GET', throw: false });
  });

  it('a non-200 resolves with its status and no body', async () => {
    const request = vi.fn(async () => ({ status: 500, arrayBuffer: new ArrayBuffer(3) }) as never);
    const { got, onChunk } = collect();
    await expect(requestUrlFetcher(request).get(URL0, onChunk)).resolves.toEqual({ status: 500 });
    expect(got).toEqual([]);
  });

  it('maps a thrown network error and refuses other hosts', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('net::ERR'), { code: 'ENOTFOUND' });
    });
    await expect(requestUrlFetcher(request).get(URL0, () => {})).rejects.toThrow(/you seem to be offline/);
    await expect(requestUrlFetcher(request).get('https://evil.example/a', () => {})).rejects.toThrow(/not the pinned/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('abort stops waiting with an AbortError; a timeout fails', async () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const ctl = new AbortController();
    const p = requestUrlFetcher(request).get(URL0, () => {}, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(requestUrlFetcher(request, { timeoutMs: 10 }).get(URL0, () => {})).rejects.toThrow(/did not answer within/);
  });
});

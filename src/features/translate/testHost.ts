// A scriptable TranslateHost for the translation UI tests (no engine, no network).
import type { DownloadOffer, DownloadProgress, TranslateHost, TranslateOutcome, TranslateRequest } from '../../translate/types';

export const OFFER: DownloadOffer = {
  from: 'en',
  to: 'uk',
  bytes: 41_000_000,
  parts: [
    { label: 'Translation engine', bytes: 5_000_000 },
    { label: 'English → Українська', bytes: 36_000_000 },
  ],
};

export interface PendingDownload {
  offer: DownloadOffer;
  signal?: AbortSignal;
  progress: (p: DownloadProgress) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class FakeTranslateHost implements TranslateHost {
  targetCode = 'uk';
  requests: TranslateRequest[] = [];
  downloads: PendingDownload[] = [];
  defaults: string[] = [];
  backgrounded: DownloadOffer[] = [];
  running = new Set<string>();
  /** What translate() answers; by default, a translation tagged with its pair. */
  answer: (req: TranslateRequest) => Promise<TranslateOutcome> | TranslateOutcome = (req) => ({
    kind: 'done',
    text: `[${req.from === 'auto' || !req.from ? 'en' : req.from}>${req.to}] ${req.text}`,
    from: req.from === 'auto' || !req.from ? 'en' : req.from,
    to: req.to ?? this.targetCode,
  });
  withBackground = true;

  target(): string {
    return this.targetCode;
  }
  languages() {
    return [
      { code: 'de', name: 'Deutsch' },
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'Français' },
      { code: 'uk', name: 'Українська' },
    ];
  }
  async translate(req: TranslateRequest): Promise<TranslateOutcome> {
    this.requests.push(req);
    return this.answer(req);
  }
  download(offer: DownloadOffer, opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
      const d: PendingDownload = { offer, signal: opts.signal, progress: (p) => opts.onProgress?.(p), resolve, reject };
      this.downloads.push(d);
      opts.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
  }
  setDefaultTarget(code: string): void {
    this.defaults.push(code);
  }
  isDownloading(from: string, to: string): boolean {
    return this.running.has(`${from}-${to}`);
  }
  get background(): ((offer: DownloadOffer) => void) | undefined {
    return this.withBackground ? (offer: DownloadOffer) => void this.backgrounded.push(offer) : undefined;
  }
}

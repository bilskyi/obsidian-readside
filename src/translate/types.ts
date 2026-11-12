// Host-agnostic translation contract (spec §A6). The shared reader UI talks to a TranslateHost;
// the Obsidian plugin implements it (downloads into the vault config dir, runs Bergamot in a
// worker). Desktop passes no host, so it shows no translation UI.

export interface TranslateRequest {
  text: string;
  from?: string | 'auto'; // ISO 639-1 or 'auto' (default)
  to?: string; // default: host's target setting
  context?: string; // nearby page text for detection
  signal?: AbortSignal;
}

export type TranslateOutcome =
  | { kind: 'done'; text: string; from: string; to: string }
  | { kind: 'same'; lang: string } // source === target
  | { kind: 'needsDownload'; offer: DownloadOffer }
  | { kind: 'unsupported'; from: string | null; to: string };

export interface DownloadOffer {
  from: string;
  to: string;
  bytes: number;
  parts: { label: string; bytes: number }[];
}

export interface DownloadProgress {
  received: number;
  total: number;
}

/** ⌥-hover's answer for one word. `unavailable`: no such pair, a blank word, or the host is closed. */
export type WordOutcome =
  | { kind: 'done'; text: string }
  | { kind: 'notInstalled' }
  | { kind: 'downloading' }
  | { kind: 'unavailable' };

export interface TranslateHost {
  target(): string;
  languages(): readonly { code: string; name: string }[];
  translate(req: TranslateRequest): Promise<TranslateOutcome>;
  /** Resolves when installed; rejects on failure/abort. Joins a download already running for the same pair. */
  download(
    offer: DownloadOffer,
    opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal },
  ): Promise<void>;
  /**
   * Installed-only fast path for ⌥-hover; it never downloads. `notInstalled` is the only miss worth a
   * "set it up" hint: a pair that is downloading now, or can't be translated at all, gets nothing.
   * `signal` drops a request still queued behind others (the pointer moved to another word).
   */
  translateWord?(word: string, from: string, to: string, signal?: AbortSignal): Promise<WordOutcome>;
  setDefaultTarget?(code: string): void;
  hoverEnabled?(): boolean;
  /** Whether a download for this pair is running now (a new card joins it instead of offering it again). */
  isDownloading?(from: string, to: string): boolean;
  /**
   * The card that was showing this pair's download closed while it runs: the host carries it on and
   * shows its progress itself (Obsidian: a Notice). Without it, the download still carries on, unseen.
   */
  background?(offer: DownloadOffer): void;
}

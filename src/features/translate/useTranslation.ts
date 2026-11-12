// One translation card's state machine over a TranslateHost (spec §A5): translating → (a download
// offer → downloading →) the result, or "already in …", or an error (with Retry when retrying can help).
//
//  - Source and target are per card: `from` starts as auto (detected), `to` as the host's target.
//    Swap, and More ▾ → From / To, re-request with the new pair.
//  - A download runs through host.download, so a card for a pair that is already downloading joins it
//    (host.isDownloading) instead of offering it again.
//  - Closing the card never stops a download: the host carries it on (host.background, a progress
//    Notice in Obsidian). Cancel stops this card's share of it (the download itself stops when nobody
//    else is waiting for it, and its partial files are removed).
//  - Unmounting aborts the translate request in flight.
//
// Shared UI: it imports no catalog (desktop bundles this file but never mounts a card); language
// names come from the host.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadOffer, DownloadProgress, TranslateHost } from '../../translate/types';

/** Input above this many characters is cut, and the card says so. */
export const MAX_INPUT = 5000;
export const NOT_AVAILABLE = "This pair isn't available offline. Choose another language under More ▾ → To.";
export const NOT_DETECTED = "Couldn't tell which language this is. Choose it under More ▾ → From.";

export type CardState =
  | { kind: 'working' }
  | { kind: 'offer'; offer: DownloadOffer }
  | { kind: 'downloading'; offer: DownloadOffer; progress: DownloadProgress }
  | { kind: 'done'; text: string; from: string; to: string; detected: boolean; truncated: boolean }
  | { kind: 'same'; lang: string; suggest: string | null }
  /** `retry` is absent when trying again can't help (an unsupported pair: the message says what to change). */
  | { kind: 'error'; message: string; retry?: () => void };

export interface Translation {
  state: CardState;
  /** The source asked for: 'auto' (detect) or a code. */
  from: string;
  /** The target asked for. */
  to: string;
  accept(): void;
  decline(): void;
  swap(): void;
  setTo(code: string): void;
  setFrom(code: string | 'auto'): void;
  cancel(): void;
}

const isAbort = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The targets of this session's translations, newest first ("Translate to …" offers the latest other one). */
const recentTargets: string[] = [];
function noteTarget(code: string): void {
  const i = recentTargets.indexOf(code);
  if (i >= 0) recentTargets.splice(i, 1);
  recentTargets.unshift(code);
  recentTargets.length = Math.min(recentTargets.length, 8);
}

/** A target other than `lang` to offer when the text is already in the target language. */
export function otherTarget(host: TranslateHost, lang: string): string | null {
  const known = new Set(host.languages().map((l) => l.code));
  const navLang = (typeof navigator !== 'undefined' ? navigator.language : '')?.split(/[-_]/)[0] ?? '';
  const candidates = [...recentTargets, host.target(), navLang, 'en', ...known];
  return candidates.find((c) => c && c !== lang && known.has(c)) ?? null;
}

export function useTranslation(host: TranslateHost, req: { text: string; context?: string }): Translation {
  const [from, setFromState] = useState<string>('auto');
  const [to, setToState] = useState<string>(() => host.target());
  /** Bumped to translate again (Retry, a finished download). */
  const [round, setRound] = useState(0);
  const [state, setState] = useState<CardState>({ kind: 'working' });
  const alive = useRef(true);
  /** This card's share of a download, while it runs. */
  const dl = useRef<{ ctl: AbortController; offer: DownloadOffer } | null>(null);

  const truncated = req.text.length > MAX_INPUT;
  const text = truncated ? req.text.slice(0, MAX_INPUT) : req.text;
  const context = req.context;

  const retry = useCallback(() => setRound((n) => n + 1), []);

  const startDownload = useCallback(
    (offer: DownloadOffer) => {
      dl.current?.ctl.abort();
      const ctl = new AbortController();
      const mine = { ctl, offer };
      dl.current = mine;
      const current = () => alive.current && dl.current === mine;
      setState({ kind: 'downloading', offer, progress: { received: 0, total: offer.bytes } });
      host
        .download(offer, {
          signal: ctl.signal,
          onProgress: (progress) => {
            if (current()) setState({ kind: 'downloading', offer, progress });
          },
        })
        .then(
          () => {
            if (!current()) return;
            dl.current = null;
            setRound((n) => n + 1);
          },
          (e: unknown) => {
            if (!current()) return;
            dl.current = null;
            if (ctl.signal.aborted && isAbort(e)) setState({ kind: 'offer', offer });
            else setState({ kind: 'error', message: messageOf(e), retry: () => startDownload(offer) });
          },
        );
    },
    [host],
  );

  useEffect(() => {
    const ctl = new AbortController();
    setState({ kind: 'working' });
    const asked = from;
    host.translate({ text, from: asked, to, context, signal: ctl.signal }).then(
      (out) => {
        if (ctl.signal.aborted) return;
        switch (out.kind) {
          case 'done':
            noteTarget(out.to);
            setState({ kind: 'done', text: out.text, from: out.from, to: out.to, detected: asked === 'auto', truncated });
            return;
          case 'same':
            setState({ kind: 'same', lang: out.lang, suggest: otherTarget(host, out.lang) });
            return;
          case 'needsDownload':
            if (host.isDownloading?.(out.offer.from, out.offer.to)) startDownload(out.offer);
            else setState({ kind: 'offer', offer: out.offer });
            return;
          case 'unsupported':
            setState({ kind: 'error', message: out.from === null ? NOT_DETECTED : NOT_AVAILABLE });
            return;
        }
      },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setState({ kind: 'error', message: messageOf(e), retry });
      },
    );
    return () => ctl.abort();
  }, [host, text, context, from, to, round, truncated, retry, startDownload]);

  // Closing the card hands a running download to the host; it is never cancelled by a close.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const d = dl.current;
      dl.current = null;
      if (d && host.background) {
        host.background(d.offer); // the host joins first …
        d.ctl.abort(); // … so leaving here never leaves the download without a joiner
      }
    };
  }, [host]);

  const accept = useCallback(() => {
    if (state.kind === 'offer') startDownload(state.offer);
  }, [state, startDownload]);

  const cancel = useCallback(() => {
    dl.current?.ctl.abort();
  }, []);

  /** "Not now": nothing is remembered (the same pair asks again next time); the card closes. */
  const decline = useCallback(() => {}, []);

  const swap = useCallback(() => {
    if (state.kind !== 'done') return;
    setFromState(state.to);
    setToState(state.from);
  }, [state]);

  const setTo = useCallback((code: string) => setToState(code), []);
  const setFrom = useCallback((code: string) => setFromState(code), []);

  return { state, from, to, accept, decline, swap, setTo, setFrom, cancel };
}

/** Up to `max` characters of `pageText` around the first occurrence of `quote` (the page's start when absent). */
export function contextAround(pageText: string, quote: string, max = 400): string {
  const page = pageText.replace(/\s+/g, ' ').trim();
  if (page.length <= max) return page;
  const q = quote.replace(/\s+/g, ' ').trim();
  const at = q ? page.indexOf(q) : -1;
  if (at < 0) return page.slice(0, max);
  const room = Math.max(0, max - q.length);
  const start = Math.max(0, Math.min(at - Math.floor(room / 2), page.length - max));
  return page.slice(start, start + max);
}

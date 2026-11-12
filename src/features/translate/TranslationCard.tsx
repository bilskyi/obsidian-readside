// The translation card (spec §A5): it takes the selection popover's place, placed and clamped the
// same way (placeOver inside the reader's bounds, from the fixed box's real origin), and shows one
// state of useTranslation at a time.
//
// Keyboard: focus moves into the card when it opens and to each state's main control (Download,
// Cancel, the translation, Retry); Esc closes it (the reader puts focus back on the page); ⌘C with
// nothing selected copies the translation; More ▾ is a menu (arrows, Home/End, a letter jumps, Esc
// closes just the menu).
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { fixedOrigin, floatBounds, placeOver } from '../../lib/floating';
import { isEditable } from '../../lib/keys';
import { downloadingText, formatMB } from '../../translate/format';
import type { DownloadOffer, TranslateHost } from '../../translate/types';
import { useTranslation, type CardState } from './useTranslation';
import './translationCard.css';

export interface TranslationCardProps {
  rect: DOMRect;
  host: TranslateHost;
  text: string;
  context?: string;
  onSaveThought: (translation: string) => void;
  onClose: () => void;
}

const GAP = 8;
const COPIED_MS = 1400;

function offerSentence(offer: DownloadOffer, name: (c: string) => string): string {
  const parts = offer.parts.map((p) => `${p.label === 'Translation engine' ? 'translation engine' : p.label} ${formatMB(p.bytes)} MB`);
  return (
    `Translating from ${name(offer.from)} to ${name(offer.to)} needs a one-time download: ${formatMB(offer.bytes)} MB` +
    `${parts.length ? ` (${parts.join(', ')})` : ''}. Everything then works offline.`
  );
}

/** What a screen reader hears when the card changes state (progress itself is on the bar). */
function statusText(s: CardState, name: (c: string) => string): string {
  switch (s.kind) {
    case 'working':
      return 'Translating…';
    case 'offer':
      return 'A download is needed';
    case 'downloading':
      return 'Downloading';
    case 'done':
      return s.text.trim() ? `Translated to ${name(s.to)}` : 'No translation';
    case 'same':
      return `Already in ${name(s.lang)}`;
    case 'error':
      return `Not translated: ${s.message}`;
  }
}

export function TranslationCard({ rect, host, text, context, onSaveThought, onClose }: TranslationCardProps) {
  const t = useTranslation(host, { text, context });
  const { state } = t;
  const names = useRef<Map<string, string> | null>(null);
  names.current ??= new Map(host.languages().map((l) => [l.code, l.name]));
  const name = useCallback((code: string) => names.current?.get(code) ?? code, []);

  const ref = useRef<HTMLDivElement>(null);
  const headId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [savedDefault, setSavedDefault] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  // ---- placement: like the selection popover ----
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placed = placeOver(rect, { width: el.offsetWidth, height: el.offsetHeight }, floatBounds(el), GAP);
    const origin = fixedOrigin(el);
    const top = placed.top - origin.y;
    const left = placed.left - origin.x;
    setPos((p) => (p && p.top === top && p.left === left && p.below === placed.below ? p : { top, left, below: placed.below }));
  });
  const style: CSSProperties = pos
    ? { position: 'fixed', top: pos.top, left: pos.left }
    : { position: 'fixed', top: rect.bottom + GAP, left: rect.left, visibility: 'hidden' };

  // ---- focus: into the card on open, then to each state's main control ----
  const ownsFocus = () => {
    const el = ref.current;
    const active = el?.ownerDocument.activeElement ?? null;
    return !!el && (!active || active === el.ownerDocument.body || el.contains(active));
  };
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !ownsFocus()) return;
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    target.focus({ preventScroll: true });
  }, [state.kind]);
  useEffect(() => {
    if (state.kind !== 'done') setMenuOpen(false);
  }, [state.kind]);

  // ---- Esc closes (from anywhere but a text field outside the card); the menu takes it first ----
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const view = ref.current?.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (isEditable(e.target) && !(e.target instanceof Node && ref.current?.contains(e.target))) return;
      e.preventDefault();
      onCloseRef.current();
    };
    view.addEventListener('keydown', onKey);
    return () => view.removeEventListener('keydown', onKey);
  }, []);

  const copy = useCallback(async () => {
    if (state.kind !== 'done' || !state.text.trim()) return;
    try {
      // The card's own window's clipboard: in an Obsidian popout window, the global one is the main window's.
      const nav = ref.current?.ownerDocument.defaultView?.navigator ?? navigator;
      await nav.clipboard.writeText(state.text);
      setCopied('ok');
    } catch {
      // the clipboard refused (no permission, no focus): say so rather than leave the button silent
      setCopied('failed');
    }
  }, [state]);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const chord = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c';
    if (chord && state.kind === 'done') {
      // The page's selection outlives the popover (the card replaced it), so a selection somewhere
      // else must not win: only a selection inside the card gets the native copy.
      const sel = ref.current?.ownerDocument.getSelection();
      const inCard = !!sel && !sel.isCollapsed && !!sel.anchorNode && !!ref.current?.contains(sel.anchorNode);
      if (inCard) return; // part of the translation selected: the native copy
      e.preventDefault();
      void copy();
    }
  };

  const fromLabel = (() => {
    if (state.kind === 'done') return name(state.from);
    if (state.kind === 'offer' || state.kind === 'downloading') return name(state.offer.from);
    if (state.kind === 'same') return name(state.lang);
    return t.from === 'auto' ? 'Auto' : name(t.from);
  })();
  const toLabel = (() => {
    if (state.kind === 'done') return name(state.to);
    if (state.kind === 'offer' || state.kind === 'downloading') return name(state.offer.to);
    return name(t.to);
  })();
  const detected = state.kind === 'done' ? state.detected : t.from === 'auto' && (state.kind === 'offer' || state.kind === 'downloading' || state.kind === 'same');

  const more = (
    <button
      ref={moreRef}
      type="button"
      className="tc-btn"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={() => setMenuOpen((o) => !o)}
    >
      More <span aria-hidden="true">▾</span>
    </button>
  );

  let body: ReactNode;
  switch (state.kind) {
    case 'working':
      body = (
        <div className="tc-working">
          <span className="tc-bar tc-bar-indeterminate" aria-hidden="true" />
          <span className="tc-dim">Translating…</span>
        </div>
      );
      break;
    case 'offer':
      body = (
        <>
          <p className="tc-message">{offerSentence(state.offer, name)}</p>
          <div className="tc-actions">
            <button type="button" className="tc-btn tc-primary" data-autofocus onClick={t.accept}>
              Download
            </button>
            <button
              type="button"
              className="tc-btn"
              onClick={() => {
                t.decline();
                onClose();
              }}
            >
              Not now
            </button>
          </div>
        </>
      );
      break;
    case 'downloading': {
      const { received, total } = state.progress;
      const label = downloadingText(state.progress);
      body = (
        <>
          <p className="tc-message tc-progress-text">{label}</p>
          <progress className="tc-progress" max={total} value={received} aria-label="Download progress" aria-valuetext={label} />
          <p className="tc-dim tc-small">Closing this card keeps the download going.</p>
          <div className="tc-actions">
            <button type="button" className="tc-btn" data-autofocus onClick={t.cancel}>
              Cancel
            </button>
          </div>
        </>
      );
      break;
    }
    case 'done': {
      // A blank result has nothing to copy or keep: no Copy, no Save as thought (an empty thought
      // would outlive the card).
      const blank = !state.text.trim();
      body = (
        <>
          {blank ? (
            <p className="tc-message tc-dim" tabIndex={-1} data-autofocus>
              No translation
            </p>
          ) : (
            <div className="tc-text" lang={state.to} tabIndex={-1} data-autofocus aria-label={`Translation in ${name(state.to)}`}>
              {state.text}
            </div>
          )}
          {state.truncated && <p className="tc-dim tc-small">Only the first 5,000 characters were translated.</p>}
          <div className="tc-actions">
            {!blank && (
              <button type="button" className="tc-btn" aria-keyshortcuts="Meta+C" onClick={() => void copy()}>
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
              </button>
            )}
            {!blank && (
              <button type="button" className="tc-btn" onClick={() => onSaveThought(state.text)}>
                Save as thought
              </button>
            )}
            <button type="button" className="tc-btn" aria-label={`Swap: translate from ${name(state.to)} to ${name(state.from)}`} onClick={t.swap}>
              <span aria-hidden="true">⇄</span> Swap
            </button>
            <span className="tc-spacer" />
            {more}
          </div>
        </>
      );
      break;
    }
    case 'same':
      body = (
        <>
          <p className="tc-message">Already in {name(state.lang)}.</p>
          <div className="tc-actions">
            {state.suggest && (
              <button type="button" className="tc-btn tc-primary" data-autofocus onClick={() => t.setTo(state.suggest!)}>
                Translate to {name(state.suggest)}
              </button>
            )}
            <span className="tc-spacer" />
            {more}
          </div>
        </>
      );
      break;
    case 'error':
      body = (
        <>
          {/* Without Retry, focus lands on the message (it says what to change), as on the other text-only states. */}
          {state.retry ? (
            <p className="tc-message tc-error">{state.message}</p>
          ) : (
            <p className="tc-message tc-error" tabIndex={-1} data-autofocus>
              {state.message}
            </p>
          )}
          <div className="tc-actions">
            {state.retry && (
              <button type="button" className="tc-btn tc-primary" data-autofocus onClick={state.retry}>
                Retry
              </button>
            )}
            <span className="tc-spacer" />
            {more}
          </div>
        </>
      );
      break;
  }

  return (
    <div
      ref={ref}
      className={pos?.below ? 'translation-card below' : 'translation-card'}
      style={style}
      // Deliberately non-modal: the page stays live behind the card (reading, scrolling, a new
      // selection), so focus is not trapped and nothing outside is inert.
      role="dialog"
      aria-modal="false"
      aria-labelledby={headId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="tc-head">
        <h2 id={headId} className="tc-langs">
          <span className="tc-sr">Translation: </span>
          {fromLabel}
          {detected && <span className="tc-detected"> (detected)</span>}
          <span aria-hidden="true"> → </span>
          <span className="tc-sr"> to </span>
          {toLabel}
        </h2>
        <button type="button" className="tc-close" aria-label="Close translation" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {body}
      {menuOpen && (
        <MoreMenu
          languages={host.languages()}
          from={t.from}
          to={t.to}
          canSetDefault={!!host.setDefaultTarget}
          savedDefault={savedDefault}
          onFrom={(c) => {
            setMenuOpen(false);
            t.setFrom(c);
          }}
          onTo={(c) => {
            setMenuOpen(false);
            setSavedDefault(false);
            t.setTo(c);
          }}
          onSetDefault={() => {
            host.setDefaultTarget?.(t.to);
            setSavedDefault(true);
          }}
          onClose={() => {
            setMenuOpen(false);
            moreRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      <p className="tc-sr" role="status">
        {statusText(state, name)}
        {copied === 'ok' ? '. Copied' : copied === 'failed' ? ". Couldn't copy" : ''}
      </p>
    </div>
  );
}

interface MoreMenuProps {
  languages: readonly { code: string; name: string }[];
  from: string;
  to: string;
  canSetDefault: boolean;
  savedDefault: boolean;
  onFrom: (code: string) => void;
  onTo: (code: string) => void;
  onSetDefault: () => void;
  onClose: () => void;
}

function MoreMenu({ languages, from, to, canSetDefault, savedDefault, onFrom, onTo, onSetDefault, onClose }: MoreMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const toId = useId();
  const fromId = useId();
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  useEffect(() => {
    // Start on the current target.
    const first = ref.current?.querySelector<HTMLElement>('[data-group="to"][aria-checked="true"]') ?? items()[0];
    first?.focus({ preventScroll: true });
    first?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const move = (to: HTMLElement | undefined) => {
    to?.focus({ preventScroll: true });
    to?.scrollIntoView?.({ block: 'nearest' });
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(e.target as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(list[(i + 1) % list.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(list[(i - 1 + list.length) % list.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(list[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(list[list.length - 1]);
    } else if (e.key === 'Tab') {
      onClose();
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // A letter jumps to the next language starting with it, within the same list.
      const group = (e.target as HTMLElement).dataset.group;
      const k = e.key.toLocaleLowerCase();
      const same = list.filter((el) => el.dataset.group === group);
      const at = same.indexOf(e.target as HTMLElement);
      const next = [...same.slice(at + 1), ...same.slice(0, at + 1)].find((el) => (el.textContent ?? '').trim().toLocaleLowerCase().startsWith(k));
      if (next) {
        e.preventDefault();
        move(next);
      }
    }
  };
  const radio = (group: 'from' | 'to', code: string, label: string, checked: boolean, pick: (c: string) => void) => (
    <button
      key={`${group}-${code}`}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-group={group}
      tabIndex={-1}
      className="tc-menu-item"
      onClick={() => pick(code)}
    >
      <span className="tc-check" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  );
  return (
    <div ref={ref} className="tc-menu" role="menu" aria-label="Translation languages" onKeyDown={onKeyDown}>
      <div className="tc-menu-cols">
        <div role="group" aria-labelledby={toId} className="tc-menu-group">
          <p id={toId} className="tc-menu-label" aria-hidden="true">
            To
          </p>
          <div className="tc-menu-list">{languages.map((l) => radio('to', l.code, l.name, l.code === to, onTo))}</div>
        </div>
        <div role="group" aria-labelledby={fromId} className="tc-menu-group">
          <p id={fromId} className="tc-menu-label" aria-hidden="true">
            From
          </p>
          <div className="tc-menu-list">
            {radio('from', 'auto', 'Auto', from === 'auto', onFrom)}
            {languages.map((l) => radio('from', l.code, l.name, l.code === from, onFrom))}
          </div>
        </div>
      </div>
      {canSetDefault && (
        <button type="button" role="menuitem" tabIndex={-1} className="tc-menu-item tc-menu-default" onClick={onSetDefault}>
          <span className="tc-check" aria-hidden="true">
            {savedDefault ? '✓' : ''}
          </span>
          Set as default target
        </button>
      )}
    </div>
  );
}

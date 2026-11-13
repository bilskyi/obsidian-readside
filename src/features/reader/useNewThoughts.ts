import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Location, Thought } from '../../lib/types';
import * as bodySaves from '../notebook/bodySaves';
import type { ThoughtSession } from '../notebook/thoughtSession';

/**
 * Where an empty new thought came from, so Undo can put it back. Only these can clean themselves up:
 * - `pin`: a thought at a line (the margin "+", a click in the margin, ⌘⇧M, "+ Thought", the page menu);
 * - `selection`: a thought made from selected text, whose yellow highlight was made only for it.
 * A thought added to a highlight that already existed hangs off something made on purpose: it never goes.
 */
export type DraftOrigin =
  | { kind: 'pin'; location: Location | null }
  | {
      kind: 'selection';
      annotationId: string;
      location: Location;
      quote: string;
      /** Its highlight was merged into one the reader made: the empty thought still goes, the highlight stays. */
      keepHighlight?: boolean;
    };

/** A removed empty thought, offered back by the "Empty thought removed · Undo" toast. */
export interface RemovedDraft {
  /** New for every removal, so the toast's timer starts over. */
  key: number;
  origin: DraftOrigin;
  /** Its highlight went with it (made only for it, still untouched). */
  highlightRemoved: boolean;
  /** Its place in the notebook's order, so Undo puts it back there (both backends take `position` in a patch). */
  position: number;
}

/** How long the undo toast stays. */
export const UNDO_MS = 6000;

/** The thought whose note, notebook entry or writing sheet has focus now (its editor, label, menu or preview), if any. */
function focusedThought(): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element)) return null;
  return active.closest<HTMLElement>('.margin-note, .nb-thought, .writing-sheet')?.dataset.thoughtId ?? null;
}

/** The thought (margin note, card or notebook entry) a pressed element belongs to, if any. */
function thoughtAt(el: Element | null): string | null {
  return el?.closest<HTMLElement>('.margin-note[data-thought-id], .nb-thought[data-thought-id], .writing-sheet[data-thought-id]')?.dataset.thoughtId ?? null;
}

/** The last press: what it hit, and the highlight under the pointer then (the renderer marks it `.hl.is-hover`). */
interface Press {
  down: boolean;
  thought: string | null;
  highlight: string | null;
}

/**
 * Still an empty new thought: nothing in its body but whitespace (its newest text, saved or not), no custom
 * name, and still hanging where it was made. (Whether text was ever typed, and whether a save is on its
 * way, are the hook's to know.)
 */
export function isEmptyDraft(t: Thought, origin: DraftOrigin): boolean {
  const body = bodySaves.unsavedBody(t.id) ?? t.body;
  if (body.trim() !== '' || (t.labelCustom ?? '').trim() !== '') return false;
  return origin.kind === 'pin' ? t.anchorId === null : t.anchorId === origin.annotationId;
}

/**
 * The highlight a selection's thought was made with goes with it only while it is still just that: yellow,
 * no note, and no other thought hanging off it. A colour, a note or another thought makes it the reader's
 * own, and it stays.
 */
export function highlightGoesToo(a: Annotation | undefined, thoughtId: string, thoughts: readonly Thought[]): boolean {
  return !!a && a.color === 'yellow' && !a.note && !thoughts.some((t) => t.id !== thoughtId && t.anchorId === a.id);
}

interface Options {
  thoughts: Thought[];
  annotations: Annotation[];
  removeThought: (id: string) => Promise<void>;
  removeAnnotation: (id: string) => Promise<void>;
  onError: (message: string) => void;
  /** Done writing: the page takes the keyboard. */
  finish: () => void;
  /** Focus leaving a thought editor anywhere in here is noticed (the reader's root). */
  root: HTMLElement | null;
  /** The highlight whose popover is open, if any: a selection's thought waits while its highlight's is. */
  popoverAnnotationId?: string | null;
}

/**
 * Thoughts made in this reader session. Each new thought's editor shows the "Esc when done" hint; an empty
 * one (DraftOrigin, isEmptyDraft) removes itself once focus has left it, offering Undo.
 *
 * It never cancels anything holding text: a body typed even once, a save still queued or failed, and focus
 * still anywhere in the thought (either surface: one live editor per thought, editorOwners) all keep it. The
 * check runs a task after focus leaves, so the editor's blur flush and an editor handover have happened;
 * when focus left at a mousedown, it waits for the pointer to come up (and a task), so the click counts: a
 * press on the thought itself keeps it, and a press that opens its highlight's popover makes it wait for
 * that popover. While its delete is on its way, its editors are read-only (`session.isRemoving`).
 */
export function useNewThoughts({
  thoughts,
  annotations,
  removeThought,
  removeAnnotation,
  onError,
  finish,
  root,
  popoverAnnotationId = null,
}: Options) {
  const created = useRef(new Set<string>());
  const drafts = useRef(new Map<string, DraftOrigin>());
  const wrote = useRef(new Set<string>());
  const latest = useRef({ thoughts, annotations, removeThought, removeAnnotation, onError, finish, popoverAnnotationId });
  useLayoutEffect(() => {
    latest.current = { thoughts, annotations, removeThought, removeAnnotation, onError, finish, popoverAnnotationId };
  });
  const [removed, setRemoved] = useState<RemovedDraft | null>(null);
  /** Thoughts whose delete is on its way: their editors are read-only, so nothing typed now is lost with them. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const removals = useRef(0);
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const windowWaits = useRef(new Set<() => void>());
  /** The press in progress (or the one just released, until the checks it held back have run). */
  const press = useRef<Press | null>(null);
  /** Checks held back while a pointer is down: they run a task after it comes up (after its click). */
  const afterPress = useRef(new Set<string>());
  /** Selection thoughts waiting while their highlight's popover is open. */
  const afterPopover = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    const waits = windowWaits.current;
    return () => {
      alive.current = false;
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
      waits.forEach((undo) => undo());
      waits.clear();
    };
  }, []);

  const later = useCallback((fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, 0);
    timers.current.add(t);
  }, []);

  /** A thought this session made; `origin` when it may clean itself up while empty. */
  const track = useCallback((id: string, origin: DraftOrigin | null) => {
    created.current.add(id);
    if (origin) drafts.current.set(id, origin);
  }, []);

  /**
   * Highlights a merge reshaped or replaced (into `into`): a selection thought made with one of them still
   * removes itself while empty, now hanging off `into`, but never takes the merged highlight along.
   */
  const releaseHighlights = useCallback((annotationIds: readonly string[], into: string) => {
    const ids = new Set(annotationIds);
    for (const [id, origin] of drafts.current) {
      if (origin.kind === 'selection' && ids.has(origin.annotationId)) {
        drafts.current.set(id, { ...origin, annotationId: into, keepHighlight: true });
      }
    }
  }, []);

  /** Text reached the thought: it is not an empty new thought any more, for good. */
  const markWritten = useCallback((id: string) => {
    wrote.current.add(id);
    drafts.current.delete(id);
  }, []);

  const check = useCallback((id: string) => {
    if (!alive.current) return;
    const origin = drafts.current.get(id);
    if (!origin) return;
    // A press is under way (focus moves at mousedown; its click comes later): decide once it is over.
    if (press.current?.down) {
      afterPress.current.add(id);
      return;
    }
    const { thoughts: list, popoverAnnotationId: popoverOn } = latest.current;
    const t = list.find((x) => x.id === id);
    if (!t) {
      drafts.current.delete(id);
      return;
    }
    // A save of its body still on its way (or failed): it stays, and it is not looked at again.
    if (bodySaves.hasUnsaved(id)) return;
    if (!isEmptyDraft(t, origin)) {
      drafts.current.delete(id);
      return;
    }
    // Focus came back to it (or moved to its other surface): still being written.
    if (focusedThought() === id) return;
    // The press was on the thought itself (its name, its menu, the notebook's preview): not leaving it.
    if (press.current?.thought === id) return;
    // Its highlight's popover is open (the reader clicked the fresh highlight to colour it or add a note):
    // it waits, and is looked at again once that popover closes.
    if (origin.kind === 'selection' && popoverOn === origin.annotationId) {
      afterPopover.current.add(id);
      return;
    }
    // The window went to the background (⌘Tab): the reader hasn't left the thought. Look again on return.
    if (!document.hasFocus()) {
      const onReturn = () => {
        windowWaits.current.delete(undo);
        check(id);
      };
      const undo = () => window.removeEventListener('focus', onReturn);
      window.addEventListener('focus', onReturn, { once: true });
      windowWaits.current.add(undo);
      return;
    }
    drafts.current.delete(id);
    // A press on the highlight itself (a drag starting there, a click about to open its popover) keeps it.
    const pressedHighlight = press.current?.highlight ?? null;
    const position = t.position;
    setRemoving((s) => new Set(s).add(id));
    void (async () => {
      const { removeThought: dropThought, removeAnnotation: dropAnnotation, onError: fail } = latest.current;
      try {
        await dropThought(id);
      } catch (e) {
        fail(String(e));
        return;
      } finally {
        if (alive.current)
          setRemoving((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
      }
      let highlightRemoved = false;
      if (origin.kind === 'selection' && !origin.keepHighlight) {
        // Looked at now, not before the delete: a colour, a note, another thought or an open popover that
        // came meanwhile make the highlight the reader's own.
        const now = latest.current;
        const anchor = now.annotations.find((a) => a.id === origin.annotationId);
        const goes =
          highlightGoesToo(anchor, id, now.thoughts) &&
          now.popoverAnnotationId !== origin.annotationId &&
          pressedHighlight !== origin.annotationId;
        if (goes && anchor) {
          try {
            await dropAnnotation(anchor.id);
            highlightRemoved = true;
          } catch (e) {
            fail(String(e));
          }
        }
      }
      if (alive.current) setRemoved({ key: ++removals.current, origin, highlightRemoved, position });
    })();
  }, []);

  const checkSoon = useCallback((id: string) => later(() => check(id)), [later, check]);

  // Focus leaving any thought editor (margin note, card, notebook entry) asks whether it was left empty.
  useEffect(() => {
    if (!root) return;
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest('.thought-editor')) return;
      const id = t.closest<HTMLElement>('.margin-note, .nb-thought')?.dataset.thoughtId;
      if (id && drafts.current.has(id)) checkSoon(id);
    };
    root.addEventListener('focusout', onFocusOut);
    return () => root.removeEventListener('focusout', onFocusOut);
  }, [root, checkSoon]);

  // Real engines move focus at mousedown (WebKit doesn't focus a clicked button; focus goes to the body or
  // the scroller), long before the click. So a press is remembered, and a check that comes during it waits
  // for the pointer to come up, plus a task, so the click has happened (a popover opened, a menu, a rename).
  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target instanceof Element ? e.target : null;
      press.current = {
        down: true,
        thought: thoughtAt(t),
        highlight: root?.querySelector<HTMLElement>('.hl.is-hover')?.dataset.id ?? null,
      };
    };
    const onUp = () => {
      const p = press.current;
      if (!p?.down) return;
      p.down = false;
      later(() => {
        const held = [...afterPress.current];
        afterPress.current.clear();
        held.forEach((id) => check(id));
        // The press counts only for the checks it held back (and those its click caused, a task earlier).
        if (press.current === p) press.current = null;
      });
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    };
  }, [root, later, check]);

  // The highlight's popover closed: the thoughts waiting on it are looked at again.
  useEffect(() => {
    if (afterPopover.current.size === 0) return;
    const waiting = [...afterPopover.current].filter((id) => {
      const o = drafts.current.get(id);
      return !(o?.kind === 'selection' && o.annotationId === popoverAnnotationId);
    });
    waiting.forEach((id) => {
      afterPopover.current.delete(id);
      checkSoon(id);
    });
  }, [popoverAnnotationId, checkSoon]);

  // The toast goes after a while (a newer removal starts it over); never while the pointer or the keyboard
  // is on it, and the full time again once they leave.
  const [held, setHeld] = useState({ hover: false, focus: false });
  const removedKey = removed?.key;
  const isHeld = held.hover || held.focus;
  useEffect(() => {
    if (removedKey === undefined) {
      setHeld((h) => (h.hover || h.focus ? { hover: false, focus: false } : h));
      return;
    }
    if (isHeld) return;
    const t = setTimeout(() => setRemoved((r) => (r?.key === removedKey ? null : r)), UNDO_MS);
    return () => clearTimeout(t);
  }, [removedKey, isHeld]);
  const dismissRemoved = useCallback(() => setRemoved(null), []);
  /** The toast is hovered or holds focus (`on`), or no longer: its timer waits meanwhile. */
  const holdRemoved = useCallback((by: 'hover' | 'focus', on: boolean) => {
    setHeld((h) => (h[by] === on ? h : { ...h, [by]: on }));
  }, []);

  const session = useMemo<ThoughtSession>(
    () => ({
      isNew: (id) => created.current.has(id) && !wrote.current.has(id),
      isRemoving: (id) => removing.has(id),
      wrote: markWritten,
      finish: (from) => {
        // The notebook hands focus back to its entry, unless the thought is about to go (empty and new):
        // then the page takes it, as from the margin.
        const target = from?.returnTo;
        const origin = from ? drafts.current.get(from.id) : undefined;
        const t = from ? latest.current.thoughts.find((x) => x.id === from.id) : undefined;
        const goes = !!origin && !!t && isEmptyDraft(t, origin);
        if (target?.isConnected && !goes) target.focus({ preventScroll: true });
        else latest.current.finish();
      },
    }),
    [markWritten, removing],
  );

  return { track, markWritten, releaseHighlights, session, removed, dismissRemoved, holdRemoved };
}

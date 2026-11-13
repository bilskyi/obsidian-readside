import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { labelText, thoughtLabel } from '../../lib/labels';
import { EntryMenu } from '../notebook/EntryMenu';
import { useEditorOwner } from '../notebook/editorOwners';
import { LabelField } from '../notebook/LabelField';
import { useInlineRename } from '../notebook/useInlineRename';
import { linkForEntry } from '../notebook/notebookModel';
import { ThoughtEditor } from '../notebook/ThoughtEditor';
import { NEW_THOUGHT_PLACEHOLDER, ThoughtSessionContext } from '../notebook/thoughtSession';
import { WritingSheetContext } from '../notebook/sheetContext';
import { ThoughtLabelView } from '../notebook/ThoughtLabel';
import { thoughtMenuItems, type ThoughtMenuActions } from '../notebook/thoughtMenu';
import { ThoughtPreview } from '../notebook/ThoughtPreview';
import { ExpandIcon } from '../notebook/ExpandIcon';
import type { MarginEntry } from './marginModel';
import './marginalia.css';

/** How long a click on the preview waits for the editor to arrive before it stops asking for focus. */
const WANT_FOCUS_MS = 1000;

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export interface MarginNoteActions extends ThoughtMenuActions {
  /** Resolves once the body is saved; rejects on failure so the editor retries. */
  onSaveThought: (id: string, body: string) => Promise<unknown>;
  /** A custom name; null restores the automatic label. */
  onRenameThought: (id: string, label: string | null) => void;
}

export interface MarginNoteProps {
  entry: MarginEntry;
  actions: MarginNoteActions;
  /** Focus the body once it can be edited here (a new thought, or one opened from the notebook). */
  autoFocus?: boolean;
  /** Created moments ago: it slides in. */
  fresh?: boolean;
  /** Created moments ago: a brief highlight pulse (an outline under reduced motion), so the eye finds it. */
  pulse?: boolean;
  className?: string;
  /** Position (a transform) and anything else the column sets. */
  style?: CSSProperties;
  onHeight?: (id: string, height: number) => void;
  /** Focus entered (true) or left (false) the note as a whole. */
  onFocusChange?: (id: string, focused: boolean) => void;
  onHoverChange?: (id: string, hovering: boolean) => void;
  /** Escape pressed inside the note and not used by anything in it (a floating card closes). */
  onEscape?: () => void;
}

/**
 * A thought written in the page margin (spec §5.2): its two-line label (click to rename inline), its body
 * (ThoughtEditor: three lines until the note has focus) and its ⋯ menu. The body is an editor only while
 * this surface owns the thought (editorOwners.ts); otherwise a preview that takes the editor over.
 */
export function MarginNote({
  entry,
  actions,
  autoFocus = false,
  fresh = false,
  pulse = false,
  className,
  style,
  onHeight,
  onFocusChange,
  onHoverChange,
  onEscape,
}: MarginNoteProps) {
  const { thought, location, anchor } = entry;
  const id = thought.id;
  const place = { location, quote: anchor?.quote ?? null };
  const label = thoughtLabel(thought, place);
  const name = labelText(label) || location.label;
  const editorLabel = `Margin thought on ${location.label}`;
  const owner = useEditorOwner(id, 'margin');
  const session = useContext(ThoughtSessionContext);
  const sheet = useContext(WritingSheetContext);
  const expand = sheet ? () => sheet.open(id) : undefined;
  const [focused, setFocused] = useState(false);
  /** Focus the editor as soon as it mounts here (asked for while a preview was showing). */
  const [wantFocus, setWantFocus] = useState(false);
  const [clipped, setClipped] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  /** Undoes the pending wait for the window to come back (see onBlur). */
  const windowReturn = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const callbacks = useRef({ onHeight, onFocusChange });
  useLayoutEffect(() => {
    callbacks.current = { onHeight, onFocusChange };
  });

  // Its height feeds the column's layout; the collapsed body fades out only when it overflows.
  const measure = useRef(() => {});
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    measure.current = () => {
      if (el.offsetHeight > 0) callbacks.current.onHeight?.(id, el.offsetHeight);
      const slot = slotRef.current;
      setClipped(!!slot && slot.scrollHeight > slot.clientHeight + 1);
    };
    measure.current();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);
  // A new body (typed elsewhere, or adopted) or the editor/preview swap can change the overflow without
  // resizing the note (it is capped at three lines while collapsed): measure again.
  useLayoutEffect(() => measure.current(), [thought.body, owner.editable]);

  // Unmounted while focused (scrolled far away, deleted): the column must not keep it as focused.
  useEffect(
    () => () => {
      windowReturn.current?.();
      windowReturn.current = null;
      if (focusedRef.current) callbacks.current.onFocusChange?.(id, false);
    },
    [id],
  );

  // A focus request for an editor that hasn't arrived lapses after a moment, so a late handoff never
  // steals focus from wherever the reader went (WebKit doesn't focus a clicked button, so there may be
  // no blur to clear it).
  useEffect(() => {
    if (!wantFocus || owner.editable) return;
    const t = setTimeout(() => setWantFocus(false), WANT_FOCUS_MS);
    return () => clearTimeout(t);
  }, [wantFocus, owner.editable]);

  // Asked to focus while the notebook still holds the editor: focus the preview (the notebook's editor
  // blurs, so this note gets the editor), then the editor once it mounts.
  useEffect(() => {
    if (autoFocus && !owner.editable) {
      previewRef.current?.focus();
      setWantFocus(true);
    }
  }, [autoFocus, owner.editable]);

  // After Enter or Escape in the name field, focus returns to the label; after a blur it stays put.
  const { renaming, startRename, finishRename } = useInlineRename(thought, actions.onRenameThought, () => labelRef.current);

  /** Reports a change only: focus coming back after the window was in the background is not a new entry. */
  const setFocus = (v: boolean) => {
    if (focusedRef.current === v) return;
    focusedRef.current = v;
    setFocused(v);
    callbacks.current.onFocusChange?.(id, v);
  };
  /** Focus has left the note: report it, and drop a focus request that hasn't been served. */
  const leave = () => {
    setFocus(false);
    setWantFocus(false);
  };
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(true);
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    // The window itself lost focus (⌘Tab, another app): the reader hasn't left the note, and the focused
    // note's mode and page must hold. The next real blur, or unmounting, releases it.
    // But what had focus may close meanwhile (the rename field commits on this blur): when the window
    // comes back, let go unless focus is still inside the note.
    if (!document.hasFocus()) {
      if (!windowReturn.current) {
        const onReturn = () => {
          windowReturn.current = null;
          if (!rootRef.current?.contains(document.activeElement)) leave();
        };
        window.addEventListener('focus', onReturn, { once: true });
        windowReturn.current = () => window.removeEventListener('focus', onReturn);
      }
      return;
    }
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented && onEscape) {
      e.preventDefault();
      onEscape();
    }
  };

  const link = linkForEntry({ kind: 'thought', thought, location, anchor });
  const items = thoughtMenuItems(thought, anchor, link, actions, startRename, expand);

  return (
    <article
      ref={rootRef}
      className={cx('margin-note', `note-${entry.color ?? 'pin'}`, focused && 'is-focused', fresh && 'is-new', pulse && 'is-pulse', className)}
      style={style}
      aria-label={`Thought: ${name}`}
      data-thought-id={id}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onMouseEnter={() => onHoverChange?.(id, true)}
      onMouseLeave={() => onHoverChange?.(id, false)}
    >
      <div className="margin-note-bar">
        {renaming ? (
          <LabelField
            initial={thought.labelCustom?.trim() ?? ''}
            placeholder={labelText(thoughtLabel({ ...thought, labelCustom: null }, place)) || 'Name this thought'}
            onDone={finishRename}
          />
        ) : (
          <button
            ref={labelRef}
            type="button"
            className="margin-note-label"
            aria-label={`Rename thought: ${name}`}
            title="Rename"
            onClick={startRename}
          >
            <ThoughtLabelView label={label} />
          </button>
        )}
        {expand && (
          <button type="button" className="thought-expand" aria-label={`Open ${name} in the writing sheet`} title="Writing sheet (⌘E)" onClick={expand}>
            <ExpandIcon />
          </button>
        )}
        <EntryMenu label={`Actions for thought on ${location.label}`} items={items} />
      </div>
      {owner.editable ? (
        <div
          ref={slotRef}
          className="thought-editor-slot"
          data-clipped={clipped && !focused ? '' : undefined}
          onFocus={() => {
            owner.onFocus();
            setWantFocus(false);
          }}
          onBlur={owner.onBlur}
        >
          <ThoughtEditor
            initialBody={thought.body}
            label={editorLabel}
            autoFocus={autoFocus || wantFocus}
            onSave={(body) => actions.onSaveThought(id, body)}
            placeholder={session.isNew(id) ? NEW_THOUGHT_PLACEHOLDER : undefined}
            // A floating card keeps its own Escape (it closes, and focus goes back to its tab or dot).
            onEscape={onEscape ? undefined : () => session.finish()}
            onFinish={() => {
              onEscape?.();
              session.finish();
            }}
            onContent={() => session.wrote(id)}
            readOnly={session.isRemoving(id)}
            onExpand={expand}
          />
        </div>
      ) : owner.inSheet && expand ? (
        <ThoughtPreview buttonRef={previewRef} body={thought.body} action="Open the writing sheet" onActivate={expand} />
      ) : (
        <ThoughtPreview buttonRef={previewRef} body={thought.body} action="Write here" onActivate={() => setWantFocus(true)} />
      )}
    </article>
  );
}

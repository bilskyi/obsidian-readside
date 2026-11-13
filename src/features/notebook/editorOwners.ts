import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  type FocusEvent,
} from 'react';

/**
 * One editor per thought (Plan 4B). A thought can show in the notebook and in the page margin at once;
 * two live editors on one body could each hold unsent text, and the one that flushed last would win.
 * So exactly one surface mounts the editor:
 * - the surface whose editor has keyboard focus keeps it until focus leaves (typing is never cut off);
 * - otherwise the margin, while a margin note for the thought is mounted;
 * - otherwise the notebook.
 * The other surface shows a read-only preview. A swap unmounts one editor (which flushes its text, as on
 * blur) and mounts the other, seeded from useThoughts' body, which every save updates synchronously.
 */
/** 'sheet': the writing sheet, which takes the thought it is open on from both of the others. */
export type Surface = 'margin' | 'notebook' | 'sheet';

export interface EditorOwners {
  /** The surface that may mount this thought's editor right now. */
  owner(id: string): Surface;
  /** A margin note for the thought is mounted; call the returned function when it unmounts. */
  hostInMargin(id: string): () => void;
  /** The writing sheet is open on this thought (null: closed); it owns that thought's editor meanwhile. */
  setSheet(id: string | null): void;
  /** That surface's editor for the thought took keyboard focus. */
  focus(id: string, surface: Surface): void;
  /** Focus left that surface's editor. Ignored unless that surface holds the focus claim. */
  blur(id: string, surface: Surface): void;
  subscribe(listener: () => void): () => void;
}

export function createEditorOwners(): EditorOwners {
  const focused = new Map<string, Surface>();
  let sheet: string | null = null;
  const hosts = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    owner: (id) => (id === sheet ? 'sheet' : (focused.get(id) ?? ((hosts.get(id) ?? 0) > 0 ? 'margin' : 'notebook'))),
    setSheet(id) {
      if (sheet === id) return;
      sheet = id;
      notify();
    },
    hostInMargin(id) {
      const count = (hosts.get(id) ?? 0) + 1;
      hosts.set(id, count);
      // Invariant: at most one margin note per thought is mounted at a time (the column renders each entry
      // once; a narrow-window card shows the note in place of its tab, never beside it). Two margin notes
      // would both be the 'margin' surface and both mount an editor. Hosts stay counted so a stray second
      // host can't release the first's claim, but in development it is a bug worth shouting about.
      if (import.meta.env.DEV && count > 1) {
        console.error(`editorOwners: ${count} margin notes host thought ${id}; at most one may (one editor per thought).`);
      }
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (hosts.get(id) ?? 1) - 1;
        if (left > 0) hosts.set(id, left);
        else hosts.delete(id);
        notify();
      };
    },
    focus(id, surface) {
      if (focused.get(id) === surface) return;
      focused.set(id, surface);
      notify();
    },
    blur(id, surface) {
      if (focused.get(id) !== surface) return;
      focused.delete(id);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Without a provider nothing is hosted in the margin, so the notebook owns every editor (the pre-4B behaviour). */
export const EditorOwnersContext = createContext<EditorOwners>(createEditorOwners());

export interface EditorOwnerState {
  /** This surface may mount the thought's editor; otherwise it shows a preview. */
  editable: boolean;
  /** The writing sheet holds the editor (the preview says so, and opening it brings the sheet back). */
  inSheet: boolean;
  /** For the element around the editor: focus claims the thought for this surface… */
  onFocus: () => void;
  /** …and leaving releases it (after the editor's own blur has flushed its text). */
  onBlur: (e: FocusEvent<HTMLElement>) => void;
}

export function useEditorOwner(id: string, surface: Surface): EditorOwnerState {
  const owners = useContext(EditorOwnersContext);
  const editable = useSyncExternalStore(owners.subscribe, () => owners.owner(id) === surface);
  const inSheet = useSyncExternalStore(owners.subscribe, () => surface !== 'sheet' && owners.owner(id) === 'sheet');
  // A margin note hosts before paint, so the notebook's preview and the margin's editor appear together.
  useLayoutEffect(() => (surface === 'margin' ? owners.hostInMargin(id) : undefined), [owners, id, surface]);
  // Unmounted while focused (deleted, book closed): give the focus claim back.
  useEffect(() => () => owners.blur(id, surface), [owners, id, surface]);
  const onFocus = useCallback(() => owners.focus(id, surface), [owners, id, surface]);
  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const box = e.currentTarget;
      // A microtask later: CodeMirror's blur handler has flushed by then, and focus that only moved
      // within the box (or came straight back) keeps the claim.
      queueMicrotask(() => {
        if (!box.isConnected || !box.contains(document.activeElement)) owners.blur(id, surface);
      });
    },
    [owners, id, surface],
  );
  return { editable, inSheet, onFocus, onBlur };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backend } from '../../lib/backend';
import type { NewThoughtInput, Thought, ThoughtPatchInput } from '../../lib/types';
import * as bodySaves from './bodySaves';

export { RETRY_BASE_MS, RETRY_MAX_MS } from './bodySaves';

/**
 * Automatic labels only ever go from null to a value. A save reply or a list read before
 * set_thought_auto_labels landed carries no labels: keep the local pair then.
 */
const keepLabels = (incoming: Thought, local: Thought): Thought =>
  incoming.labelSnippet == null && local.labelSnippet != null
    ? { ...incoming, labelSection: local.labelSection, labelSnippet: local.labelSnippet }
    : incoming;

/** Thought state for one book. Mirrors useAnnotations. */
export function useThoughts(bookId: string) {
  const [items, setItems] = useState<Thought[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });
  /** Bumped on every book change and on unmount; results from an older generation are dropped. */
  const generation = useRef(0);
  /** Per-id count of renames (labelCustom patches) started; the newest one owns a failure's revert. */
  const renameEpoch = useRef(new Map<string, number>());
  /** Per-id count of renames still in flight. */
  const renamesInFlight = useRef(new Map<string, number>());
  /** While a rename is in flight, a reply or list read from before it must not bring the old name back. */
  const keepCustom = useCallback(
    (incoming: Thought, local: Thought): Thought =>
      renamesInFlight.current.has(incoming.id) ? { ...incoming, labelCustom: local.labelCustom } : incoming,
    [],
  );

  /**
   * Replaces items with a DB list, but keeps the local body of any thought whose body is newer than
   * the list can be: a save queued or in flight, a save that failed, or a save started after the
   * list was requested.
   */
  const applyList = useCallback((list: Thought[], epochs: ReadonlyMap<string, number>) => {
    setItems((local) => {
      const mine = new Map(local.map((x) => [x.id, x]));
      return list.map((x) => {
        const own = mine.get(x.id);
        // Text that never reached the DB (or a save started after the list was requested) wins
        // over the list, even when this hook just mounted: the store outlives the reader.
        const keepLocal = bodySaves.hasUnsaved(x.id) || bodySaves.epochOf(x.id) !== (epochs.get(x.id) ?? 0);
        const merged = own ? keepCustom(keepLabels(x, own), own) : x;
        if (!keepLocal) return merged;
        const body = bodySaves.unsavedBody(x.id) ?? own?.body;
        return body === undefined ? merged : { ...merged, body };
      });
    });
  }, [keepCustom]);

  // Every confirmed body save, including a retry the store sent on its own: merge the reply's
  // metadata. The local body is always at least as new as the reply.
  useEffect(
    () =>
      bodySaves.onSaved((t) =>
        setItems((xs) => xs.map((x) => (x.id === t.id ? { ...keepCustom(keepLabels(t, x), x), body: x.body } : x))),
      ),
    [keepCustom],
  );

  /** Queues a body save. Resolves once this body or a newer one is persisted. */
  const saveBody = useCallback((id: string, body: string) => {
    // Body edits show immediately, so an editor that remounts never starts from stale text.
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, body } : x)));
    return bodySaves.saveBody(id, body);
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    setItems([]);
    setError(null);
    const epochs = bodySaves.snapshotEpochs();
    backend()
      .listThoughts(bookId)
      .then((list) => {
        if (generation.current === gen) applyList(list, epochs);
      })
      .catch((e) => {
        if (generation.current === gen) setError(String(e));
      });
    return () => {
      generation.current++;
      // Leaving the book (or the reader): try failed text once more now. If it fails again the
      // store keeps it, keeps retrying with backoff and stays in the ⌘Q flush.
      void bodySaves.retryFailed();
    };
  }, [bookId, applyList]);

  /** Re-reads from the database, e.g. after deleting a highlight moved its thoughts' locations. */
  const reload = useCallback(async () => {
    const gen = generation.current;
    const epochs = bodySaves.snapshotEpochs();
    const list = await backend().listThoughts(bookId);
    if (generation.current === gen) applyList(list, epochs);
  }, [bookId, applyList]);

  const create = useCallback(
    async (input: Omit<NewThoughtInput, 'bookId'>) => {
      const t = await backend().createThought({ ...input, bookId });
      setItems((xs) => [...xs, t]);
      return t;
    },
    [bookId],
  );

  /**
   * Sends a patch without a body right away (unlink, move, rename). A rename shows at once; while it
   * is in flight, replies and list reads keep the local name (see keepCustom).
   */
  const sendMeta = useCallback(async (id: string, patch: Omit<ThoughtPatchInput, 'body'>) => {
    const renames = patch.labelCustom !== undefined;
    let epoch = 0;
    let before: string | null = null;
    if (renames) {
      epoch = (renameEpoch.current.get(id) ?? 0) + 1;
      renameEpoch.current.set(id, epoch);
      renamesInFlight.current.set(id, (renamesInFlight.current.get(id) ?? 0) + 1);
      before = itemsRef.current.find((x) => x.id === id)?.labelCustom ?? null;
      const name = patch.labelCustom?.trim() || null; // stored trimmed; blank = automatic
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, labelCustom: name } : x)));
    }
    const settle = () => {
      const n = (renamesInFlight.current.get(id) ?? 1) - 1;
      if (n > 0) renamesInFlight.current.set(id, n);
      else renamesInFlight.current.delete(id);
    };
    let t: Thought;
    try {
      t = await backend().updateThought(id, patch);
    } catch (e) {
      if (renames) {
        settle();
        // The newest rename failed and nothing newer is pending: show the name the DB still has.
        if (renameEpoch.current.get(id) === epoch && !renamesInFlight.current.has(id)) {
          setItems((xs) => xs.map((x) => (x.id === id ? { ...x, labelCustom: before } : x)));
        }
      }
      throw e;
    }
    if (renames) settle();
    // Body edits only ever start locally, so the local body is always at least as new as any reply
    // (a body save and a non-body update such as Unlink can race on the backend).
    setItems((xs) => xs.map((x) => (x.id === id ? { ...keepCustom(keepLabels(t, x), x), body: x.body } : x)));
    return t;
  }, [keepCustom]);

  const update = useCallback(
    async (id: string, patch: ThoughtPatchInput) => {
      const { body, ...meta } = patch;
      if (body === undefined) return sendMeta(id, meta);
      const saved = saveBody(id, body);
      if (Object.keys(meta).length === 0) return saved;
      const [, t] = await Promise.all([saved, sendMeta(id, meta)]);
      return t;
    },
    [saveBody, sendMeta],
  );

  const remove = useCallback(async (id: string) => {
    await backend().deleteThought(id);
    bodySaves.forget(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  /**
   * Stores automatic labels (spec §3.2). Only the label fields are taken from the reply: the local
   * body is always at least as new, and an unlink or move may be in flight.
   */
  const setAutoLabels = useCallback(async (id: string, section: string | null, snippet: string) => {
    const t = await backend().setThoughtAutoLabels(id, section, snippet);
    setItems((xs) =>
      xs.map((x) => (x.id === id ? { ...x, labelSection: t.labelSection, labelSnippet: t.labelSnippet } : x)),
    );
    return t;
  }, []);

  return { items, error, create, update, remove, reload, setAutoLabels };
}

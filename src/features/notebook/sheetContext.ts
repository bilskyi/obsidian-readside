import { createContext } from 'react';

/** Opens the writing sheet on a thought; null where there is no sheet (no reader around the editor). */
export interface WritingSheetOpener {
  open(thoughtId: string): void;
}

export const WritingSheetContext = createContext<WritingSheetOpener | null>(null);

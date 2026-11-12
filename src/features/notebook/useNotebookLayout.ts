import { usePanelLayout } from '../panels/usePanelLayout';

export const MIN_WIDTH = 260;
export const MAX_WIDTH = 640;
export const DEFAULT_WIDTH = 340;

const LAYOUT = {
  openKey: 'margin.notebook.open',
  widthKey: 'margin.notebook.width',
  min: MIN_WIDTH,
  max: MAX_WIDTH,
  defaultWidth: DEFAULT_WIDTH,
};

/** Notebook open state and width, remembered per device. */
export function useNotebookLayout() {
  return usePanelLayout(LAYOUT);
}

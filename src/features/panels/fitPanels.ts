/** The narrowest the reading column gets while side panels are open (px). */
export const MIN_READING_COLUMN = 360;

export interface PanelSize {
  /** The stored (preferred) width. */
  width: number;
  min: number;
}

export interface FitPanelsInput {
  /** Present only when the panel is open. */
  contents?: PanelSize;
  notebook?: PanelSize;
}

export type FitPanelsResult = { contents?: number; notebook?: number };

/**
 * The widths to render the open side panels at so the reading column keeps `minColumn` of the
 * `available` width: the notebook gives way first, then contents, neither below its own minimum.
 * The stored preferences are not changed; widen the window and the panels grow back. An unknown
 * `available` (0, e.g. before layout) leaves the preferred widths alone.
 */
export function fitPanels(available: number, panels: FitPanelsInput, minColumn = MIN_READING_COLUMN): FitPanelsResult {
  const out: FitPanelsResult = {};
  if (panels.contents) out.contents = panels.contents.width;
  if (panels.notebook) out.notebook = panels.notebook.width;
  if (!(available > 0)) return out;
  let excess = (out.contents ?? 0) + (out.notebook ?? 0) + minColumn - available;
  for (const key of ['notebook', 'contents'] as const) {
    const p = panels[key];
    if (!p || excess <= 0) continue;
    const give = Math.min(excess, Math.max(0, p.width - p.min));
    out[key] = p.width - give;
    excess -= give;
  }
  return out;
}

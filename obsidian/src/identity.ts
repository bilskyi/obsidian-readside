/**
 * The plugin's name and the names it had before. The plugin was called Margin (id `margin-reader`) and
 * is now Readside (id `readside`); the desktop app is still Margin.
 *
 * What the user reads says Readside. These identifiers deliberately keep the old name, so nothing
 * already in a vault breaks:
 * - the view types `margin-reader` (VIEW_TYPE) and `margin-shelf` (SHELF_VIEW_TYPE): workspace.json
 *   names them, and a renamed type would leave every open reader tab as an empty placeholder;
 * - the CSS scope class `.margin-app`, the `margin-*` keyframes and every other class;
 * - the window key UNLOADING_KEY (`__margin-reader-unloading`) that hands an update over to the next
 *   instance (only one plugin build reads it, so its name is invisible);
 * - the data files (index.json, books/, mirrors.json, …) and their formats, and the notebook notes'
 *   `margin-book` / `margin-progress` properties;
 * - command ids (Obsidian prefixes them with the plugin id anyway).
 * Links: `obsidian://readside` is the action new links use; `obsidian://margin` stays registered as an
 * alias for good, because notes written before the rename hold such links.
 */
export const APP_NAME = 'Readside';
/** The protocol action new links use (`obsidian://readside?…`). */
export const PROTOCOL_ACTION = 'readside';
/** The protocol action of links written as Margin; still opened, never written. */
export const LEGACY_PROTOCOL_ACTION = 'margin';
/** The plugin id (and so the data folder under `<configDir>/plugins/`) before the rename. */
export const LEGACY_PLUGIN_ID = 'margin-reader';
/** The notebook notes folder an install from before the rename keeps using. */
export const LEGACY_MIRROR_FOLDER = 'Margin';

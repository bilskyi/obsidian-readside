import { normalizePath, type DataAdapter } from 'obsidian';
import { LEGACY_PLUGIN_ID } from './identity';

/** The plugin's own files: each install has its own, so they are never imported. */
const NOT_DATA = new Set(['main.js', 'manifest.json', 'styles.css']);
/** Where an import is assembled inside the new folder before its entries move into place. */
export const IMPORT_TMP = '.import-from-margin-reader';
export const IMPORTED_NOTICE = 'Readside: imported your books and notes from Margin.';

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function copyFolder(adapter: DataAdapter, from: string, to: string): Promise<void> {
  await adapter.mkdir(to);
  const { files, folders } = await adapter.list(from);
  for (const f of files) await adapter.copy(f, `${to}/${base(f)}`);
  for (const d of folders) await copyFolder(adapter, d, `${to}/${base(d)}`);
}

/**
 * Copies the data of the plugin's old folder (`<configDir>/plugins/margin-reader/`) into its own folder
 * `root`, once: only while `root` has no index.json and the old folder has one. Everything but main.js,
 * manifest.json and styles.css is copied; the old folder is left as it was.
 *
 * Safe to interrupt: the copy is assembled in `root/.import-from-margin-reader/`, then each entry is
 * renamed into place (replacing one an interrupted import left), index.json last. Until index.json is in
 * place the next load imports again from scratch. Resolves true when it imported.
 */
export async function importLegacyData(adapter: DataAdapter, configDir: string, root: string): Promise<boolean> {
  const old = normalizePath(`${configDir}/plugins/${LEGACY_PLUGIN_ID}`);
  if (normalizePath(root) === old) return false;
  if (await adapter.exists(`${root}/index.json`)) return false;
  if (!(await adapter.exists(`${old}/index.json`))) return false;

  const tmp = `${root}/${IMPORT_TMP}`;
  if (await adapter.exists(tmp)) await adapter.rmdir(tmp, true);
  await adapter.mkdir(tmp);
  const { files, folders } = await adapter.list(old);
  const names: string[] = [];
  for (const f of files) {
    const name = base(f);
    if (NOT_DATA.has(name)) continue;
    await adapter.copy(f, `${tmp}/${name}`);
    names.push(name);
  }
  for (const d of folders) {
    const name = base(d);
    await copyFolder(adapter, d, `${tmp}/${name}`);
    names.push(name);
  }

  // index.json last: it is what says the import is done.
  names.sort((a, b) => Number(a === 'index.json') - Number(b === 'index.json'));
  for (const name of names) {
    const dest = `${root}/${name}`;
    const existing = await adapter.stat(dest);
    if (existing?.type === 'folder') await adapter.rmdir(dest, true);
    else if (existing) await adapter.remove(dest);
    await adapter.rename(`${tmp}/${name}`, dest);
  }
  await adapter.rmdir(tmp, true);
  return true;
}

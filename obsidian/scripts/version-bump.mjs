// Sets the plugin's version from package.json: manifest.json gets `version`, and versions.json maps that
// version to manifest.json's minAppVersion (Obsidian uses versions.json to offer older users an older
// release). Run after `npm version` / `pnpm version`, or by hand:
//   node obsidian/scripts/version-bump.mjs            # version from package.json
//   node obsidian/scripts/version-bump.mjs 0.2.0      # an explicit version
// Every manifest.json listed below that exists is updated (the standalone repo keeps a copy at its root,
// where Obsidian's directory reads it); they must stay identical.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const obsidianDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(obsidianDir, '..');

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error(`version-bump: "${version}" is not x.y.z`);
  process.exit(1);
}

const manifests = [join(obsidianDir, 'manifest.json'), join(repo, 'manifest.json')].filter(existsSync);
let minAppVersion = null;
for (const file of manifests) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  // Only a manifest of this plugin (the desktop app's repo root has none; never touch another file).
  if (m.id !== 'readside') continue;
  m.version = version;
  minAppVersion ??= m.minAppVersion;
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`version-bump: ${file} -> ${version}`);
}
if (!minAppVersion) {
  console.error('version-bump: no readside manifest.json found');
  process.exit(1);
}

const versionsFiles = [join(obsidianDir, 'versions.json'), join(repo, 'versions.json')].filter(existsSync);
if (versionsFiles.length === 0) versionsFiles.push(join(obsidianDir, 'versions.json'));
for (const file of versionsFiles) {
  const versions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  versions[version] = minAppVersion;
  writeFileSync(file, `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`version-bump: ${file} ${version} -> ${minAppVersion}`);
}

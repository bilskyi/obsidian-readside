// Bundles the Obsidian plugin: obsidian/src/main.ts + shared src/ → obsidian/dist/{main.js,styles.css,manifest.json}.
//   node obsidian/esbuild.config.mjs production   minified build, size budget enforced
//   node obsidian/esbuild.config.mjs --watch      dev build on every change (the test vault symlinks dist/)
import esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeCss } from './src/css/scope.ts';
import { MAIN_JS_BUDGET, MPL_NOTICE, buildOptions, createsScriptElement, usesLookbehind } from './scripts/buildOptions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const production = process.argv.includes('production');
const watch = process.argv.includes('--watch');

/** styles.css (scoped), manifest copy; returns main.js's size. */
async function finish() {
  const bundled = await readFile(join(dist, 'main.css'), 'utf8').catch(() => '');
  // reset first (neutralises Obsidian's global element styles), bridge last (theme tokens win).
  const reset = await readFile(join(here, 'src', 'css', 'reset.css'), 'utf8');
  const bridge = await readFile(join(here, 'src', 'css', 'bridge.css'), 'utf8');
  await writeFile(join(dist, 'styles.css'), `${reset}\n${scopeCss(bundled)}\n${bridge}`);
  await rm(join(dist, 'main.css'), { force: true });
  await copyFile(join(here, 'manifest.json'), join(dist, 'manifest.json'));
  return (await stat(join(dist, 'main.js'))).size;
}

const options = buildOptions({ production });

await mkdir(dist, { recursive: true });
if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      ...options.plugins,
      {
        name: 'margin-finish',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            const size = await finish();
            console.log(`margin: rebuilt (main.js ${Math.round(size / 1024)} KiB)`);
          });
        },
      },
    ],
  });
  await ctx.watch();
} else {
  await esbuild.build(options);
  const size = await finish();
  console.log(`margin: main.js ${Math.round(size / 1024)} KiB (budget ${MAIN_JS_BUDGET / 1024} KiB)`);
  if (production && size > MAIN_JS_BUDGET) {
    console.error(`margin: main.js is ${size} bytes, over the ${MAIN_JS_BUDGET}-byte budget`);
    process.exit(1);
  }
  // The vendored Bergamot glue is MPL-2.0: its header must ship with it, verbatim.
  const js = await readFile(join(dist, 'main.js'), 'utf8');
  if (production && !js.includes(MPL_NOTICE)) {
    console.error('margin: main.js lacks the MPL-2.0 header of the vendored Bergamot glue');
    process.exit(1);
  }
  // Obsidian's plugin review rejects runtime script injection.
  if (createsScriptElement(js)) {
    console.error("margin: main.js contains createElement('script')");
    process.exit(1);
  }
  // Obsidian on older iPhones and iPads (iOS < 16.4) can't parse a lookbehind: nothing would load.
  if (usesLookbehind(js)) {
    console.error('margin: main.js contains a regex lookbehind; use src/lib/notAfter.ts');
    process.exit(1);
  }
}

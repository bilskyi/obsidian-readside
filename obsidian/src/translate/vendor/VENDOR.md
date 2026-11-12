# Vendored: Bergamot translator JS glue

## `bergamot-translator.js`

- **What.** The Emscripten JS glue for Mozilla's Bergamot translator (Marian NMT compiled to wasm), as vendored by Firefox. It defines `loadBergamot(Module)`.
- **Source.** https://github.com/mozilla/firefox/blob/2c8de06acae0a9edcbd1e0e49f951a0cbfe427a2/toolkit/components/translations/bergamot-translator/bergamot-translator.js
  - Commit `2c8de06acae0a9edcbd1e0e49f951a0cbfe427a2`, "Bug 1970390 - Update the bergamot-translator to v0.6.0" (2025-06-06).
  - Git blob `640e215c9725e12fdcd77693e48e5055c235d309`, 99,827 bytes.
  - The glue reports `BERGAMOT_VERSION_FULL = "v0.6.0+1de4a085d"`. That commit's `moz.yaml` names `release: v0.6.0`, `revision: 1de4a085d3a7afb625c51a60aabb5ad298e4059f` of https://github.com/mozilla/translations.
- **Licence.** MPL-2.0 (http://mozilla.org/MPL/2.0/). The upstream MPL header is kept.
- **Changes.** A 7-line provenance comment is prepended. Every byte after it is the upstream file, unmodified.
  - upstream sha256: `972fa0450146fe06f4006a2ba56e8c4834403e27873cfe47fb3ba85aa7b9b082`
  - vendored file sha256 (with the comment): `79b8911debd5c94a63e5c22a3a62e7ce20d4df7d3e98bda5ddbd61b01299b264`
  - Check: `tail -n +8 bergamot-translator.js | shasum -a 256` prints the upstream hash. `obsidian/test/translateVendor.test.ts` asserts it.

### The wasm it pairs with

An Emscripten glue only loads the wasm it was built with, so this exact glue revision is pinned to this record.

- **Record.** Remote Settings `main/translations-wasm`, record `4fd32605-9889-4dd9-9fc7-577ad1136746`.
  - name `bergamot-translator`, version `3.0`, release `v0.6.0`
  - revision `1de4a085d3a7afb625c51a60aabb5ad298e4059f`, fx_release `141.0a1`, license `MPL-2.0`
  - last_modified 1749069444811 (2025-06-04)
- **Attachment.** `bergamot-translator.wasm`, 4,960,506 bytes, sha256 `a3a89d9ad0a4ed8f27bf3e403701b23f5709816f6376438503f2fa5b0182c2dc`
  - URL: https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-wasm/05082c31-aee8-4249-9e01-c1865afd7520.wasm
  - `src/translate/catalog.ts` `ENGINE` pins the same values.

### Why not a later Firefox revision

Later commits change the glue for **rebuilt** wasm binaries, and none of those binaries is in Remote Settings:

| Commit | Date | Glue version | Glue sha256 |
|---|---|---|---|
| `02fefb1e` | 2025-09-29 | `v0.6.0+4a6a44c0` (new build hash) | `24a48d7f…` |
| `9140dac1` | 2025-09-29 | same, with patched instantiation (Bug 1988289) | `fb2dfc1d…` |
| `48d55cf7` | 2026-01-29 | `v0.6.0+eea6e5a8` (auto-generated header) | `faff1ef6…` |

`2c8de06a` is the only glue whose revision `1de4a085` is the wasm record's revision.

## Smoke run (T1)

- **Script.** `node obsidian/scripts/bergamot-smoke.mjs` (2026-11-11)
- **Platform.** Node v24.18.0, V8 13.6, macOS. `WebAssembly.mozIntGemm` is absent, so the glue printed "Using fallback gemm implementation".
- **Setup.**
  - The glue ran in a `vm` context shaped like a worker.
  - `loadBergamot({ wasmBinary, INITIAL_MEMORY: 41943040 })`.
  - Firefox's model config with `gemm-precision: int8shiftAlphaAll`.
  - `BlockingService({ cacheSize: 0 })`.

| Pair | Input | Output | Model build | First translation | Second translation |
|---|---|---|---|---|---|
| uk→en v1.1 | `Привіт, світ. Як справи?` | `Greet, the world. How are you?` | 46 ms | 77 ms | 8 ms |
| en→uk v2.2 | `The quick brown fox jumps over the lazy dog.` | `Швидка коричнева лисиця стрибає через ледачого собаку.` | 30 ms | 70 ms | 25 ms |

- **Engine start.** About 12 ms, measured from bytes in hand to `onRuntimeInitialized`.
- **Heap.** It grew from 40 MiB to 302 MiB with both models loaded.
- **Downloads.** The engine plus both pairs (62.5 MB) took about 58 s. All sha256 checks passed.

**Chromium.** The same check also ran in headless Chrome 157, with the same outputs. It used the shipping shape:
- a `blob:` Worker that loads the glue with `importScripts(blob:)`;
- wasm and model bytes posted in as transferables.

Timings in Chrome:
- model build plus first translation: 146 ms (uk→en) and 112 ms (en→uk);
- engine start: 12 ms.

Obsidian's CSP (blob: workers, wasm compile inside Obsidian) is **not** covered here. It is checked when the worker lands in the plugin.

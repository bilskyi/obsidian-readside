import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE } from '../../src/translate/catalog';

// The vendored Bergamot glue is Firefox's file byte for byte under a short provenance comment.
// It must stay the revision that matches the pinned wasm: an Emscripten glue only loads the wasm
// it was built with.
const VENDORED = resolve(__dirname, '../src/translate/vendor/bergamot-translator.js');
const UPSTREAM_SHA256 = '972fa0450146fe06f4006a2ba56e8c4834403e27873cfe47fb3ba85aa7b9b082';
const FIREFOX_COMMIT = '2c8de06acae0a9edcbd1e0e49f951a0cbfe427a2';

describe('vendored Bergamot glue', () => {
  const text = readFileSync(VENDORED, 'utf8');
  const end = text.indexOf(' */\n') + ' */\n'.length;
  const provenance = text.slice(0, end);
  const upstream = text.slice(end);

  it('names its source commit and licence in the provenance comment', () => {
    expect(provenance.startsWith('/* Vendored by Margin')).toBe(true);
    expect(provenance).toContain(`mozilla/firefox/blob/${FIREFOX_COMMIT}/toolkit/components/translations/bergamot-translator/bergamot-translator.js`);
    expect(provenance).toContain('MPL-2.0');
  });

  it('is the upstream file unmodified, MPL header first', () => {
    expect(createHash('sha256').update(upstream, 'utf8').digest('hex')).toBe(UPSTREAM_SHA256);
    expect(upstream.startsWith('/* This Source Code Form is subject to the terms of the Mozilla Public')).toBe(true);
  });

  it('is the build that pairs with the catalog engine', () => {
    expect(upstream).toContain(`var BERGAMOT_VERSION_FULL = "${ENGINE.release}+1de4a085d";`);
    expect(ENGINE.release).toBe('v0.6.0');
    expect(upstream).toContain('function loadBergamot(Module) {');
  });
});

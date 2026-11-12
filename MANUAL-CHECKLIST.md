# Manual checklist

What the automated tests cannot confirm because it needs real Obsidian (desktop, 1.8.0+). Use the test
vault (`pnpm setup:obsidian-vault`, `pnpm build:obsidian`) first, then a copy of a real vault. Never
experiment in a vault you have no backup of.

> **Before any step in a real vault:** back it up (at least `.obsidian`). Never click **Uninstall** on
> Margin in Community plugins: it deletes `<vault>/.obsidian/plugins/margin-reader/` with every book's
> highlights and thoughts. Disable it instead, or copy `books/` and `backups/` out first. To update, replace
> only `main.js`, `styles.css` and `manifest.json`.

Setup: open `obsidian/test-vault`, enable Margin, open `Books/Walden.pdf` with Margin.

## Reading basics
- [ ] Ribbon book icon opens the picker; choosing Walden opens it in a Margin tab. Page renders sharp, text layer selectable.
- [ ] Explorer right-click on a PDF: "Open in Margin". A `[[Walden.pdf]]` link in a note, right-click: the same item.
- [ ] Select text: the selection popover appears next to it and inside the pane (not clipped by the tab, not behind panes). Highlight, underline, add a note; each survives closing and reopening the tab.
- [ ] Notebook panel (⌘\ or the command) opens inside the pane, lists entries, resizes with the pane and with a split.
- [ ] Contents, find, zoom, page turns work with mouse and with the commands.

## Keys
- [ ] Reader shortcuts work whenever the Margin tab is active, including right after clicking the tab header or the status bar, with focus outside the view.
- [ ] ⌘F opens Margin's find, not Electron's or Obsidian's search. ⌘− / ⌘0 / zoom-in (⌘+ and ⌘=) zoom the book and do not zoom the Obsidian UI (Electron menu accelerators).
- [ ] PageUp/PageDown and ⌥←/⌥→ turn pages with focus in the page area; in the contents list or notebook they scroll that panel.
- [ ] Typing in a thought, search or page field keeps its own keys; ⌘ chords still work there.
- [ ] Windows/Linux (if available): ⌘ chords do nothing; each command id (new-thought, toggle-notebook, toggle-contents, find, zoom-in, zoom-out, zoom-fit, next-page, prev-page) can be bound under Hotkeys and works in a Margin tab only.

## Opening and focus
- [ ] Setting "Open PDFs in Margin" is off by default: a PDF opened from the explorer, with a non-Margin tab active, opens in Obsidian's viewer. With a Margin tab active, it loads in that Margin tab.
- [ ] Turn it on: opening a PDF from the explorer, from the quick switcher and from a `[[x.pdf]]` link switches the active tab to Margin. Activating an existing Obsidian PDF tab, or one restored at startup, also switches it. A PDF in another split or another window stays in Obsidian's viewer.
- [ ] With a Margin tab of Walden in the background since startup (not yet shown), "Open in Margin" on Walden switches to that tab; no second tab opens.
- [ ] `[[Walden.pdf#page=3]]` lands on page 3.
- [ ] After each way of opening (explorer, switcher, tab click) keyboard focus is in the reader: page keys work without clicking first.
- [ ] `obsidian://margin?file=Books%2FWalden.pdf&loc=...` (from a notebook-note link) jumps and flashes every time, even when already at that spot; an already open tab is reused.
- [ ] The PDF view's `#page` handoff: open Obsidian's own PDF viewer on a subpath, with the setting on, and confirm Margin shows that page (no flash of the wrong page).

## Plugin lifecycle
- [ ] Toggle Margin off and on in Community plugins with a book open: the tab goes away cleanly; turning it on again, a reopened workspace shows a placeholder tab that becomes the book when focused. Notes and highlights are intact. Check the unload order in the developer console: no errors, no "previous instance did not finish" warning.
- [ ] Reinstall (replace main.js, styles.css, manifest.json, then toggle, then also reload Obsidian): the open tab reopens as a placeholder and returns to the same page; no store errors.
- [ ] Disable the plugin while typing a thought (do not click away): reopen, the text is in the thought. A notice appears only if a save really failed.
- [ ] Turn a page, then at once quit Obsidian (⌘Q): on relaunch the book opens at the new page.
- [ ] Quit with a thought half-typed: on relaunch the text is there.
- [ ] Recovery notices (copy the vault first): corrupt `books/<id>.json` with no backup, with a backup, and `index.json`: each gives its notice (kept aside / restored / rebuilt) that stays until dismissed; the damaged copy is kept.

## Notebook note
- [ ] `Margin/Walden.md` appears about 1.5 s after the first highlight; sections follow the outline; page links open the book at that page.
- [ ] Changing the folder in settings moves the notes; turning "Notebook notes" off stops rewriting.
- [ ] Mirror note open in a split pane while reading: page turns make no copies and no note flicker. Adding a thought (or highlight) rewrites the note; if you had typed into the note meanwhile, a copy `Walden (edited ...).md` appears once, with a notice. Edit the note and change nothing in Margin: no copy. Reading forward (new furthest pages) alone does not rewrite the note; `margin-progress` catches up on the next real change. If the note is open with unsaved edits when Margin rewrites it, Obsidian merges and shows a "file changed" notice.
- [ ] Rename or move the PDF in the explorer: the book, its notes and the note follow.
- [ ] Disable Margin, move the PDF in the explorer (or in Finder with Obsidian closed), enable Margin, open the PDF at its new place: its highlights and thoughts are there. A copy of a PDF (the original still in the vault) opens as a new, empty book.

## Look
- [ ] Light and dark themes (a community theme too): desk behind the page, surfaces (margin, notebook, popover), accent fill contrast on buttons, pressed vs hover states are all distinguishable and readable; switching theme live updates without reopening.
- [ ] No Margin styles leak: other panes, the settings dialog, and the status bar look unchanged.

## Compatibility and scale
- [ ] The thought editor (CodeMirror) works inside Obsidian: typing, undo, selection, IME, no console errors about duplicate `@codemirror/state` instances. Obsidian ships state 6.5 and view 6.38; confirm it runs on those.
- [ ] Coexists with PDF++: both enabled, open the same PDF in each; no duplicated or broken highlights, no hotkey clashes, "Open PDFs in Margin" on and off both behave.
- [ ] A 500+ page book: opens quickly, scrolling and zoom stay smooth, memory stays sane, find and contents work, the note regenerates promptly.

## EPUB
Setup: `pnpm setup:obsidian-vault -- --epub`, then open `Books/Pride and Prejudice.epub` and `Books/The Picture of Dorian Gray.epub`.

- [ ] 1. Click an `.epub` in the file list. Expected: it opens in Margin; sections flow as one column; the title is the book's.
- [ ] 2. Scroll the whole book. Expected: images appear as they come near; no jumps while reading.
- [ ] 3. Select text, highlight with 1-5, pencil, add a note; reload Obsidian. Expected: highlights are repainted.
- [ ] 4. `+` in the margin, ⌘⇧M, and T on a selection. Expected: margin notes with threads; tabs or a card when the pane is narrow.
- [ ] 5. Focus mode. Expected: dots work on an EPUB.
- [ ] 6. ⌘F search across sections. Expected: a results list; Enter steps through hits; the current hit pulses.
- [ ] 7. Contents: pick entries with fragments. Expected: they jump inside a chapter; auto labels name the right chapter.
- [ ] 8. Zoom ±, Fit. Expected: text reflows; notes stay beside their lines.
- [ ] 9. Click an internal link and a footnote ref, then an external link. Expected: internal ones jump; external opens the browser.
- [ ] 10. Open `Margin/<book>.md`. Expected: sections follow the TOC; `§ N · “…”` links jump back into the book.
- [ ] 11. Copy link, paste in a note, click it. Expected: it jumps; backlinks show in the reader.
- [ ] 12. Open the shelf. Expected: the EPUB's cover shows.
- [ ] 13. Desktop app: import an EPUB in the library and read it. Expected: it reads. Known follow-ups: book fonts don't load (the desktop CSP has no `font-src` for `blob:`), external links do nothing, title and author come from the file name, no covers.
- [ ] 14. Hostile sample (a hand-made EPUB with `<script>alert(1)</script>`, `onerror`, a remote image). Expected: nothing runs; no network request in DevTools (Network tab, filter off). Also check, each in a section of the sample, that DevTools shows no request and nothing applies:
  - CSS `@import url(https://…)`, `background: url(https://…)`, a remote `@font-face { src: url(https://…) }`, `list-style-image: url(https://…)`;
  - `<svg><image href="https://…"/></svg>`, `<img srcset="https://… 2x">`, `<link rel="stylesheet" href="https://…">`, `<meta http-equiv="refresh" content="0;url=https://…">`, `<base href="https://…">`;
  - a duplicate-spine book (one `<itemref>` repeated thousands of times): it opens at once, as one section;
  - a gigapixel image inside a section (a PNG header declaring 60000 × 60000): its alt text shows in a dashed box, the tab's memory stays flat.
- [ ] 15. Open a fixed-layout EPUB, then a DRM EPUB. Expected: a clear error for each.
- [ ] 16. Light and dark themes. Expected: text and links readable; no publisher colours.
- [ ] 17. A paragraph with lots of inline markup (em, links, footnote refs): add a thought in it with `+`. Expected: the auto label and the saved position start at the line start, not mid-line.
- [ ] 18. A book with CSS `white-space: pre-wrap` or `display: inline-block` blocks. Expected: no stray blank lines or spaces between blocks.
- [ ] 19. Side-by-side cells or floats (a table of columns): click, and add a thought, in the right-hand column. Expected (known limitation: hit-testing uses height only): note where it lands; it should be the column you clicked, and any miss is the known limit.
- [ ] 20. Ruby text: search for a base word, then highlight a ruby phrase. Expected (known): search ignores the readings; the highlight's quote still includes them.
- [ ] 21. A book whose `body` has huge padding. Expected: text stays in the column.
- [ ] 22. Reopen an EPUB. Expected (known): the progress bar may briefly show the section start, then updates to the saved spot (about 1.5 s); the view itself returns to the saved spot.
- [ ] 23. Desktop app: read mid-chapter, quit with ⌘Q, reopen. Expected: it returns to the same spot.
- [ ] 23a. Desktop app: highlight two phrases, then select across both and pick a colour. Expected: one highlight over both. Known: merging highlights on desktop gives the merged highlight a new id, so older margin:// links to them stop resolving.
- [ ] 24. With an EPUB open, click the file explorer to focus it, press PageDown. Expected: the book scrolls one screen.
- [ ] 25. Hostile EPUB whose title is `<img src=https://example.com/x.gif>` and whose cover declares 40000×40000. Expected: the mirror note shows the title text literally; nothing loads (no request to example.com); the shelf shows the colour tile, not a cover.

## Translation

Downloads are real (about 27–41 MB for the first pair). Use the test vault, with the developer console
open (View → Toggle developer tools) and its Network tab when a step says so. `translation/` below means
`<vault>/.obsidian/plugins/margin-reader/translation/`. Set Settings → Translation → "Translate to" to
Українська unless a step says otherwise. Walden is English; for Ukrainian text, use any Ukrainian PDF.

### Obsidian's CSP (verified statically; smoke-test it here)
- [ ] Select an English sentence, press L, Download, wait for the translation. The engine runs in a
  `blob:` worker and compiles its wasm there. Verified statically: Obsidian's only CSP is a `<meta>`
  `style-src` (no `script-src`, `worker-src` or `default-src`, and no CSP header), so both are allowed;
  this step is the real-app smoke test.
  Expected: the translation appears. If the engine can't start, the card shows "Margin couldn't start the
  translation engine: <cause>; update Obsidian or report this", within about a minute at worst, never a
  spinner that stays. Nothing is written to `translation/` but the downloads (no `worker.js`).
  **Report back:**
  - Obsidian version and OS;
  - whether a translation appeared;
  - if not, the card's full message and how long it took to appear;
  - any console line that mentions `Content Security Policy`, `worker`, `blob:`, `wasm` or `unsafe-eval`
    (copy it as is).

### Selection card
- [ ] 1. **Offer.** Fresh vault (empty `translation/`): select an English sentence, press L.
  Expected: the card offers the download with its parts and sizes: "Translation engine" (about 5 MB) and
  "English → Українська" (about 36 MB), with the total. Download has keyboard focus. Nothing was fetched
  yet (Network tab).
- [ ] 2. **Download.** Click Download.
  Expected: "Downloading… x of y MB" counts up with a bar; then the card shows the translation, and its
  header names both languages (English → Українська).
- [ ] 3. **Close mid-download.** Start another pair's download (target Deutsch), then close the card (×
  or Esc) while it runs.
  Expected: a Notice with the progress stays until it ends, then says "… is downloaded. Translation now
  works offline." Reopen a card for the same text before it ends: the card shows the running download
  again (the Notice goes), and the Network tab shows no second request for the same files.
- [ ] 4. **Cancel.** Start a download, click Cancel.
  Expected: the download stops; no `.part` file is left in `translation/` (check the folder); the pair
  is offered again next time.
- [ ] 5. **Offline.** With a pair downloaded, turn Wi-Fi off.
  Expected: selecting text of that pair and pressing L translates; ⌥-hover on its words works. A pair not
  downloaded shows the offer; Download then fails with a plain message, not a hang.
- [ ] 6. **Already in the target.** Ukrainian text with target Українська, press L.
  Expected: "Already in Українська." with a "Translate to …" button for the last other language used.
- [ ] 7. **Swap and pivot.** On a translated card: ⇄ Swap translates the other way (offering that
  direction's model if missing). More → To: Deutsch on Ukrainian text offers a pivot download that lists
  both legs (Українська → English and English → Deutsch) and their total.
- [ ] 8. **Save as thought.** Click Save as thought.
  Expected: the selection gets a yellow highlight with a thought whose body is the translation, shown in
  the margin; it appears in `Margin/<book>.md` after about 1.5 s.
- [ ] 9. **Copy.** Click Copy, and separately press ⌘C (Ctrl+C) with nothing selected in the card.
  Expected: the clipboard holds the translation, not the page text. Selecting part of the translation and
  pressing ⌘C copies just that part.
- [ ] 13. **Ukrainian keyboard layout.** Switch the system layout to Ukrainian, select text, press the L
  key (it types "д").
  Expected: the card opens as with L.

### ⌥-hover
- [ ] 10. **Hover.** Hold ⌥ (Alt) alone and rest the pointer on a word of an installed pair (PDF; EPUB too
  once EPUB reading has landed).
  Expected: after about 0.2 s a tooltip over the word shows the translation, a small `en → uk` and the
  original word. Moving to another word replaces it; releasing ⌥, scrolling, leaving the text or switching
  windows hides it. For a pair not downloaded, every word you rest on says "Select text and press L to set
  up English → Українська", and nothing downloads (Network tab). While that pair is downloading, nothing
  shows. Turning "⌥-hover translates words" off stops it at once. ⌥←/→, selection, highlight hover and the
  margin + behave as they do without ⌥-hover. Holding ⌥ still (key auto-repeat) keeps the tooltip.
- [ ] **Windows and Linux: Alt and the menu bar.** With a native window frame (Settings → Appearance →
  Window frame style: Native), a lone Alt press and release focuses the window's menu bar. Hover with Alt,
  then release Alt.
  Expected: the tooltip hides. Note whether the menu bar took focus and whether the next keys (arrows,
  page keys, typing in a thought) went to the menu instead of Margin. Repeat with the default (hidden)
  frame. Report both, with the OS.
- [ ] **Partial words.** Hover words in a PDF whose text layer splits words into many spans (some
  scanned or typeset PDFs do), and a word broken by a hyphen at a line end.
  Expected (known limit): it may translate part of a word or each half separately. Note how common it is.

### Settings and files
- [ ] 11. **Settings.** Settings → Translation: "Translate to" lists languages by their own names; the
  next card uses a changed target. "Downloaded languages" lists pairs with sizes and the engine's size.
  Remove a pair: its folder under `translation/models/` is gone and the list updates; the next L on that
  pair offers it again. Removing the last pair removes `translation/engine/` too. Remove all asks "Click
  again to remove all", then empties `translation/`. While a download runs, the pairs it needs and Remove
  all are disabled.
- [ ] 12. **Damaged model.** With the app closed (or Margin off), truncate a model file
  (`translation/models/en-uk/<version>/model.enuk.intgemm.alphas.bin`, for example `truncate -s 1000`).
  Expected: after Margin starts, that pair is treated as not downloaded: L offers it again, Settings no
  longer lists it, and downloading it again works.
- [ ] **Off during a download.** Turn Margin off and on (or update it) while a download runs.
  Expected: the download stops; no `.part` file stays in `translation/` (a leftover is removed about 10 s
  after the next load).

### Look
- [ ] 14. Light and dark themes (and a community theme): the card, its progress bar and the tooltip are
  readable, with clear borders; switching theme live updates them. With "Reduce motion" on in the OS, the
  card and tooltip appear without animation.

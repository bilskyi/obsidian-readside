import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import { insertLink, toggleWrap } from './format';

/**
 * A small Bold / Italic / Link bar over a thought's selected text (a mouse or trackpad selection; touch
 * has the system's own menu and the writing sheet's toolbar). It shows while the editor has focus and
 * the selection holds text, and acts like ⌘B, ⌘I and `[[`.
 */
const BUTTONS: { label: string; text: string; run: (v: EditorView) => boolean; cls?: string }[] = [
  { label: 'Bold (⌘B)', text: 'B', run: (v) => toggleWrap(v, '**'), cls: 'is-bold' },
  { label: 'Italic (⌘I)', text: 'I', run: (v) => toggleWrap(v, '*'), cls: 'is-italic' },
  { label: 'Link a note', text: '[[ ]]', run: insertLink },
];

function barFor(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (sel.empty || state.readOnly) return null;
  return {
    pos: sel.from,
    end: sel.to,
    above: true,
    strictSide: false,
    arrow: false,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'cm-format-bar';
      dom.setAttribute('role', 'toolbar');
      dom.setAttribute('aria-label', 'Format');
      for (const b of BUTTONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.text;
        btn.title = b.label;
        btn.setAttribute('aria-label', b.label);
        if (b.cls) btn.classList.add(b.cls);
        // mousedown: the editor keeps focus and its selection while the button acts.
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          b.run(view);
        });
        dom.appendChild(btn);
      }
      return { dom };
    },
  };
}

export function formatBar(): Extension {
  const field = StateField.define<Tooltip | null>({
    create: () => null,
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      // A selection being dragged out with the pointer gets its bar once it is let go (the next update).
      return barFor(tr.state);
    },
    provide: (f) => showTooltip.from(f),
  });
  return [
    field,
    // Only while the editor has focus: a selection left behind in a blurred editor shows nothing.
    EditorView.theme({ '&:not(.cm-focused) .cm-format-bar': { display: 'none' } }),
  ];
}

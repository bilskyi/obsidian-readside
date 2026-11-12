import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HINT_KEYS_MAC, HINT_KEYS_TOUCH, HINT_TEXT, HINT_TEXT_TOUCH, MarginHint } from '../../src/features/marginalia/MarginHint';

describe('MarginHint', () => {
  it('on a desktop: hover the edge, and the shortcut', () => {
    render(<MarginHint style={{}} onDismiss={() => {}} mac touch={false} />);
    expect(screen.getByRole('note').textContent).toContain(`${HINT_TEXT} ${HINT_KEYS_MAC}`);
  });

  it('on a touch screen: tap the margin, and the toolbar +; no hover, no keys', () => {
    render(<MarginHint style={{}} onDismiss={() => {}} mac touch />);
    const text = screen.getByRole('note').textContent ?? '';
    expect(text).toContain(`${HINT_TEXT_TOUCH} ${HINT_KEYS_TOUCH}`);
    expect(text).not.toMatch(/Hover|⌘/);
  });
});

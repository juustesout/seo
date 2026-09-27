/**
 * R5.6.3: the SEO surface of the Intelligence Rail is contextual to the open
 * document. It renders only the deterministic evaluation it is given (no
 * invented values), surfaces each non-pass check's existing suggestion as an
 * inline actionable line, and shows the measured document signals.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evaluateSeo, type TipDoc } from '@seo/contracts';
import { SeoPanel } from './SeoPanel';

const DOC: TipDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello world content here.' }] },
  ],
};

const result = evaluateSeo({ doc: DOC, meta: { title: '', targetKeyword: null, metaTitle: null, metaDescription: null } });

const baseProps = {
  result,
  targetKeyword: '',
  metaTitle: '',
  metaDescription: '',
};

describe('SeoPanel contextual surface', () => {
  it('renders the deterministic score and the measured document signals', () => {
    render(<SeoPanel {...baseProps} />);
    expect(screen.getByText(String(result.score))).toBeTruthy();
    const signals = screen.getByTestId('seo-document-signals').textContent ?? '';
    expect(signals).toContain(`${result.stats.words} words`);
    expect(signals).toContain(`${result.stats.headings} headings`);
    expect(signals).toContain(`${result.stats.links} links`);
    expect(signals).toContain(`${result.stats.images} images`);
  });

  it('promotes an existing non-pass suggestion to an inline actionable line', () => {
    render(<SeoPanel {...baseProps} />);
    // `title_present` fails for this document and carries a real suggestion.
    expect(screen.getByText(/Set an article title/)).toBeTruthy();
  });

  it('shows honest not-applicable checks instead of fabricating a result', () => {
    render(<SeoPanel {...baseProps} />);
    expect(screen.getAllByText('No target keyword set — not evaluated').length).toBeGreaterThan(0);
  });

  it('binds metadata fields to the workspace only when editable', () => {
    const onKeywordChange = vi.fn();
    const { rerender } = render(<SeoPanel {...baseProps} />);
    const keyword = () => screen.getByPlaceholderText('e.g. content engine') as HTMLInputElement;
    expect(keyword().disabled).toBe(true);

    rerender(<SeoPanel {...baseProps} editable onKeywordChange={onKeywordChange} />);
    expect(keyword().disabled).toBe(false);
    fireEvent.change(keyword(), { target: { value: 'content engine' } });
    expect(onKeywordChange).toHaveBeenCalledWith('content engine');
  });
});

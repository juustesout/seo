import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CANONICAL_DOCUMENT_VERSION, type CanonicalDocument, type TipDoc } from '@seo/contracts';
import { canonicalFromEditorDocument } from '../editorDraft';
import { PreviewPane } from './PreviewPane';
import type { PreviewViewport } from './previewViewport';

vi.mock('../editorDraft', () => ({ canonicalFromEditorDocument: vi.fn() }));

const mocked = vi.mocked(canonicalFromEditorDocument);

const doc: TipDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };

const canonicalWithCopy: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Preview me' }] }],
};

function frameSrc(): string {
  return screen.getByTestId('preview-frame').getAttribute('srcdoc') ?? '';
}

beforeEach(() => {
  mocked.mockReset();
});

describe('PreviewPane', () => {
  it('renders the active document through the canonical renderer inside an isolated frame', () => {
    mocked.mockReturnValue(canonicalWithCopy);
    render(<PreviewPane doc={doc} />);

    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    expect(screen.queryByTestId('preview-fallback')).toBeNull();

    const frame = screen.getByTestId('preview-frame');
    // Isolated: a sandboxed srcdoc frame that loads no application CSS.
    expect(frame.getAttribute('sandbox')).toBe('');
    // The same canonical representation, tokens inlined, renderer stylesheet injected.
    expect(frameSrc()).toContain('data-cosmos-document');
    expect(frameSrc()).toContain('cosmos-container');
    expect(frameSrc()).toContain('Preview me');
    expect(frameSrc()).toContain('--cosmos-color-primary');
    expect(frameSrc()).toContain('.cosmos-doc');
  });

  it('states plainly when the document cannot be represented', () => {
    mocked.mockImplementation(() => {
      throw new Error('unrepresentable');
    });
    render(<PreviewPane doc={doc} />);
    expect(screen.getByTestId('preview-fallback')).toBeTruthy();
    expect(screen.queryByTestId('preview-pane')).toBeNull();
  });

  it('renders the same representation at every viewport mode, changing only the frame width', () => {
    mocked.mockReturnValue(canonicalWithCopy);
    const viewports: Array<[PreviewViewport, number]> = [
      ['desktop', 1280],
      ['tablet', 834],
      ['mobile', 390],
    ];
    const { rerender } = render(<PreviewPane doc={doc} viewport="desktop" />);
    const desktopSrc = frameSrc();

    for (const [id, width] of viewports) {
      rerender(<PreviewPane doc={doc} viewport={id} />);
      const frame = screen.getByTestId('preview-frame');
      expect(frame.getAttribute('data-viewport')).toBe(id);
      expect(frame.getAttribute('data-width')).toBe(String(width));
      expect(frame.style.width).toBe(`${width}px`);
      // Same document representation regardless of the inspection width.
      expect(frameSrc()).toBe(desktopSrc);
    }
  });

  it('reports viewport changes to the workspace without owning the state', () => {
    mocked.mockReturnValue(canonicalWithCopy);
    const onViewportChange = vi.fn();
    render(<PreviewPane doc={doc} viewport="desktop" onViewportChange={onViewportChange} />);

    expect(screen.getByRole('button', { name: 'Desktop' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(onViewportChange).toHaveBeenCalledWith('mobile');
    // Controlled: the prop, not the click, decides the active mode.
    expect(screen.getByTestId('preview-frame').getAttribute('data-viewport')).toBe('desktop');
  });
});

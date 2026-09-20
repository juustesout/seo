import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CANONICAL_DOCUMENT_VERSION, type CanonicalDocument, type TipDoc } from '@seo/contracts';
import { canonicalFromEditorDocument } from '../editorDraft';
import { PreviewPane } from './PreviewPane';

vi.mock('../editorDraft', () => ({ canonicalFromEditorDocument: vi.fn() }));

const mocked = vi.mocked(canonicalFromEditorDocument);

const doc: TipDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };

beforeEach(() => {
  mocked.mockReset();
});

describe('PreviewPane', () => {
  it('renders the canonical document when it can be represented', () => {
    const canonical: CanonicalDocument = { version: CANONICAL_DOCUMENT_VERSION, blocks: [] };
    mocked.mockReturnValue(canonical);
    render(<PreviewPane doc={doc} />);
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    expect(screen.queryByTestId('preview-fallback')).toBeNull();
  });

  it('states plainly when the document cannot be represented', () => {
    mocked.mockImplementation(() => {
      throw new Error('unrepresentable');
    });
    render(<PreviewPane doc={doc} />);
    expect(screen.getByTestId('preview-fallback')).toBeTruthy();
    expect(screen.queryByTestId('preview-pane')).toBeNull();
  });
});

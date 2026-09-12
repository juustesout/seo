import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extractTextMock, extractRawTextMock } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  extractRawTextMock: vi.fn(),
}));

vi.mock('unpdf', () => ({ extractText: extractTextMock }));
vi.mock('mammoth', () => ({ default: { extractRawText: extractRawTextMock } }));

import type { KnowledgeFile } from '@seo/contracts';
import { createDocxFileExtractor, createPdfFileExtractor, createTextFileExtractor } from './extractors.js';

function file(overrides: Partial<KnowledgeFile> = {}): KnowledgeFile {
  const bytes = overrides.bytes ?? new Uint8Array([0x68, 0x69]);
  return {
    filename: 'notes.txt',
    contentType: 'text/plain',
    size: bytes.length,
    bytes,
    ...overrides,
  };
}

beforeEach(() => {
  extractTextMock.mockReset();
  extractRawTextMock.mockReset();
});

describe('text file extractor', () => {
  it('decodes UTF-8 and strips a BOM', async () => {
    const extractor = createTextFileExtractor();
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Hello')]);
    const result = await extractor.extract(file({ filename: 'Notes.md', contentType: 'text/markdown', bytes: withBom }));
    expect(result.contentText).toBe('Hello');
    expect(result.title).toBe('Notes');
    expect(result.contentType).toBe('text/markdown');
  });

  it('supports txt and md by content type or extension', () => {
    const extractor = createTextFileExtractor();
    expect(extractor.supports(file({ contentType: 'text/plain' }))).toBe(true);
    expect(extractor.supports(file({ contentType: 'text/markdown' }))).toBe(true);
    expect(extractor.supports(file({ filename: 'notes.txt', contentType: '' }))).toBe(true);
    expect(extractor.supports(file({ filename: 'doc.pdf', contentType: 'application/pdf' }))).toBe(false);
  });
});

describe('pdf file extractor', () => {
  it('merges pages and returns the text', async () => {
    extractTextMock.mockResolvedValue({ totalPages: 2, text: 'PDF body' });
    const result = await createPdfFileExtractor().extract(file({ filename: 'Doc.pdf', contentType: 'application/pdf' }));
    expect(extractTextMock).toHaveBeenCalledWith(expect.any(Uint8Array), { mergePages: true });
    expect(result.contentText).toBe('PDF body');
    expect(result.title).toBe('Doc');
  });

  it('maps parser failures to a stable extract-failed code', async () => {
    extractTextMock.mockRejectedValue(new Error('password protected'));
    await expect(
      createPdfFileExtractor().extract(file({ filename: 'Doc.pdf', contentType: 'application/pdf' })),
    ).rejects.toMatchObject({ code: 'knowledge_file_extract_failed' });
  });
});

describe('docx file extractor', () => {
  it('extracts raw text via mammoth', async () => {
    extractRawTextMock.mockResolvedValue({ value: 'Word body', messages: [] });
    const result = await createDocxFileExtractor().extract(
      file({ filename: 'Doc.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    );
    expect(extractRawTextMock).toHaveBeenCalledWith({ buffer: expect.any(Buffer) });
    expect(result.contentText).toBe('Word body');
    expect(result.title).toBe('Doc');
  });

  it('maps parser failures to a stable extract-failed code', async () => {
    extractRawTextMock.mockRejectedValue(new Error('corrupt zip'));
    await expect(
      createDocxFileExtractor().extract(
        file({ filename: 'Doc.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      ),
    ).rejects.toMatchObject({ code: 'knowledge_file_extract_failed' });
  });
});

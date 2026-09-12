/**
 * Plain-text extractors for uploaded knowledge files (KB4).
 *
 * Each extractor is a pure function over in-memory bytes: no storage, no
 * network, no command execution, no embedded-script evaluation. Failures are
 * normalized to `KnowledgeIngestError` codes so parsers never leak stack traces
 * or their own error bodies to the UI. Emptiness is not decided here - the
 * service applies `knowledge_file_no_extractable_text` after normalization so
 * the rule is identical for every source type.
 */

import type { ExtractedDocument, KnowledgeFile, KnowledgeFileExtractor } from '@seo/contracts';
import { KnowledgeIngestError } from '../errors.js';

function stripExtension(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]+$/, '').trim() || filename.trim();
}

function decodeUtf8(bytes: Uint8Array): string {
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return new TextDecoder('utf-8', { fatal: false }).decode(body);
}

/** TXT and Markdown: decode UTF-8 (Markdown is stored as plain text). */
export function createTextFileExtractor(): KnowledgeFileExtractor {
  return {
    id: 'knowledge-text-file',
    name: 'Plain text',
    formats: ['txt', 'md'],
    supports: (file) =>
      file.contentType === 'text/plain' ||
      file.contentType === 'text/markdown' ||
      file.contentType === 'text/x-markdown' ||
      /\.(md|markdown|txt)$/i.test(file.filename),
    async extract(file: KnowledgeFile): Promise<ExtractedDocument> {
      return {
        contentText: decodeUtf8(file.bytes),
        title: stripExtension(file.filename),
        contentType: file.contentType,
      };
    },
  };
}

/** PDF: text layer only via unpdf (bundled pdf.js). No OCR, no rendering. */
export function createPdfFileExtractor(): KnowledgeFileExtractor {
  return {
    id: 'knowledge-pdf-file',
    name: 'PDF',
    formats: ['pdf'],
    supports: (file) => file.contentType === 'application/pdf' || /\.pdf$/i.test(file.filename),
    async extract(file: KnowledgeFile): Promise<ExtractedDocument> {
      try {
        const { extractText } = await import('unpdf');
        const { text } = await extractText(new Uint8Array(file.bytes), { mergePages: true });
        return { contentText: text, title: stripExtension(file.filename), contentType: file.contentType };
      } catch (err) {
        if (err instanceof KnowledgeIngestError) throw err;
        throw new KnowledgeIngestError('knowledge_file_extract_failed');
      }
    },
  };
}

/** DOCX: raw text via mammoth. No HTML conversion; no external relationships. */
export function createDocxFileExtractor(): KnowledgeFileExtractor {
  return {
    id: 'knowledge-docx-file',
    name: 'Word document',
    formats: ['docx'],
    supports: (file) =>
      file.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(file.filename),
    async extract(file: KnowledgeFile): Promise<ExtractedDocument> {
      try {
        const { default: mammoth } = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: Buffer.from(file.bytes) });
        return { contentText: result.value, title: stripExtension(file.filename), contentType: file.contentType };
      } catch (err) {
        if (err instanceof KnowledgeIngestError) throw err;
        throw new KnowledgeIngestError('knowledge_file_extract_failed');
      }
    },
  };
}

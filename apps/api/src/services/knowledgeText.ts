/**
 * Deterministic text handling for knowledge ingestion (KB2).
 *
 * Two responsibilities, deliberately kept free of AI and external calls:
 *
 *  1. `normalizeText` - whitespace/line-ending cleanup only. It never rewrites
 *     or summarizes content; the source row's `content_text` stays the source
 *     of truth and this is only the processing representation handed to the
 *     chunker/embedder.
 *  2. `extractSourceText` - the one canonical extractor registry. `text`
 *     sources are extracted here; `url` and `file` return an honest
 *     "not available" result until KB3 (URL fetch) / KB4 (file parsing) add
 *     real extractors, so the later capabilities slot into the same pipeline
 *     instead of a parallel one. No extractor ever fabricates content.
 */

import type { KnowledgeSourceType } from '@seo/contracts';

/** Normalized body + display metadata produced by an extractor. */
export interface ExtractedSourceText {
  text: string;
  title: string;
  url?: string;
}

export type ExtractionFailureCode = 'empty' | 'not_available';

export type ExtractionResult =
  | { ok: true; value: ExtractedSourceText }
  | { ok: false; code: ExtractionFailureCode; reason: string };

/**
 * Deterministic whitespace + line-ending normalization:
 *   - CRLF / CR line endings -> LF
 *   - runs of spaces/tabs collapsed to one space
 *   - leading/trailing spaces/tabs stripped from every line
 *   - runs of 3+ newlines collapsed to one blank line
 *   - leading/trailing whitespace trimmed
 *
 * Idempotent (normalizing twice equals normalizing once) and order-stable.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Row shape read from seo_knowledge_sources (only the fields extraction needs). */
export interface SourceTextRow {
  source_type?: unknown;
  name?: unknown;
  url?: unknown;
  content_text?: unknown;
}

/**
 * Extract the body to index for one source row using the type's extractor.
 * `text` uses the pasted body; `url`/`file` are honest no-ops until their
 * extractors exist. Returns a precise reason so callers can report reality.
 */
export function extractSourceText(row: SourceTextRow): ExtractionResult {
  const sourceType = ((row.source_type as KnowledgeSourceType | null) ?? 'text') as KnowledgeSourceType;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const url = typeof row.url === 'string' && row.url.trim() ? row.url.trim() : undefined;
  const raw = typeof row.content_text === 'string' ? row.content_text : '';

  if (sourceType === 'file') {
    return {
      ok: false,
      code: 'not_available',
      reason: 'File ingestion is not available yet. Paste the text instead.',
    };
  }

  const text = normalizeText(raw);
  if (!text) {
    return sourceType === 'url'
      ? {
          ok: false,
          code: 'not_available',
          reason: 'Fetching page content for URL sources is not available yet.',
        }
      : { ok: false, code: 'empty', reason: 'This source has no text to index.' };
  }

  return { ok: true, value: { text, title: name || url || 'Knowledge source', url } };
}

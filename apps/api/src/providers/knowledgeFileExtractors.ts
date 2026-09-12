/**
 * Knowledge file extractor registry (KB4).
 *
 * The single seam that maps an uploaded file to the extractor that can read it.
 * `KnowledgeService` depends on this registry only, so adding a supported
 * format means adding an extractor here - never touching the pipeline, the
 * routes or the UI.
 */

import type { KnowledgeFile, KnowledgeFileExtractor } from '@seo/contracts';
import {
  createDocxFileExtractor,
  createPdfFileExtractor,
  createTextFileExtractor,
} from '../knowledge/files/extractors.js';

export class KnowledgeFileExtractorRegistry {
  constructor(private readonly extractors: readonly KnowledgeFileExtractor[]) {}

  /** All registered extractors (for diagnostics/tests). */
  all(): readonly KnowledgeFileExtractor[] {
    return this.extractors;
  }

  /** The extractor that handles this file, or null when the format is unsupported. */
  resolve(file: KnowledgeFile): KnowledgeFileExtractor | null {
    return this.extractors.find((extractor) => extractor.supports(file)) ?? null;
  }
}

export function createKnowledgeFileExtractors(): KnowledgeFileExtractorRegistry {
  return new KnowledgeFileExtractorRegistry([
    createTextFileExtractor(),
    createPdfFileExtractor(),
    createDocxFileExtractor(),
  ]);
}

/**
 * Deterministic chunking for knowledge documents (KB2).
 *
 * Extracted from the Qdrant provider so the splitting strategy is explicit,
 * unit-testable and shared by every extractor (text now; url/file later). It
 * performs no AI and no external calls: only whitespace collapsing and a
 * stable, bounded, overlap-preserving split.
 *
 * Guarantees:
 *   - deterministic: same input -> same chunks, in the same order
 *   - bounded: every chunk is at most `target` characters
 *   - non-empty: blank input yields no chunks (never an empty string chunk)
 *   - no torn words at a boundary when a nearby space exists
 */

/** Target characters per chunk - small enough to embed well, large enough to stay coherent. */
export const CHUNK_TARGET = 900;
/** Characters of overlap so sentence boundaries near a cut are not lost. */
export const CHUNK_OVERLAP = 100;

/**
 * Split text into overlapping chunks. Whitespace runs are collapsed first so
 * chunking treats rendered text (newlines/indentation) as one surface; cuts
 * prefer the last space boundary near the target so words are not torn. The
 * overlap window plus boundary preference keeps each chunk self-contained for
 * embedding quality.
 */
export function chunkKnowledgeText(
  text: string,
  target: number = CHUNK_TARGET,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= target) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(' ', end);
      if (boundary > start + target * 0.6) end = boundary;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

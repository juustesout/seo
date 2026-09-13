/**
 * Source Detail "Content" section (KBUI2).
 *
 * Shows what actually made it into the Knowledge Base, within the API's bounded
 * safe preview: the extracted text as plain data, a clear truncation note, and
 * the original URL for reference. File sources keep their bytes in private
 * storage and have no preview, so the section says so honestly instead of
 * pretending there is content. No storage path or private object URL is ever
 * rendered - the API does not expose one.
 */
import type { KnowledgeSourceDetailDto } from '@seo/contracts';
import { fmtNum } from '@/lib/ui';
import { SourceSection } from './SourceSection';

export function SourcePreview({ detail }: { detail: KnowledgeSourceDetailDto }) {
  return (
    <SourceSection title="Content">
      {detail.source_type === 'url' && detail.url && (
        <div className="truncate font-mono text-xs text-muted-foreground" title={detail.url}>
          {detail.url}
        </div>
      )}

      {detail.preview ? (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
            {detail.preview.text}
          </pre>
          <p className="text-[11px] text-muted-foreground">
            {detail.preview.truncated
              ? `Preview truncated to the first ${fmtNum(detail.preview.text.length)} characters of ${fmtNum(detail.preview.characters)}.`
              : `${fmtNum(detail.preview.characters)} characters stored.`}
          </p>
        </>
      ) : detail.source_type === 'file' ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Preview unavailable for this source type. The original document stays in private storage.
        </p>
      ) : (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          No stored content to preview yet. Processing may not have completed.
        </p>
      )}
    </SourceSection>
  );
}

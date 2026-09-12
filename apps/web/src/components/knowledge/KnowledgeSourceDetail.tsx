/**
 * Knowledge source detail drawer (KB5).
 *
 * A read-only, safe surface for one source: identity, timestamps, chunk count,
 * type-specific metadata, the safe error sentence and a bounded plain-text
 * preview. It is not a document viewer - no PDF/DOCX/Markdown/HTML rendering -
 * and content is always treated as text.
 */
import { knowledgeErrorMessage, type KnowledgeSourceDetailDto } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDate, fmtNum } from '@/lib/ui';
import { KnowledgeSourceActions } from './KnowledgeSourceActions';
import { fileLabel, formatBytes, SOURCE_STATUS_LABELS, SOURCE_TYPE_LABELS, statusBadgeVariant } from './format';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export function KnowledgeSourceDetail({
  detail,
  loading,
  error,
  canEdit,
  busy,
  onClose,
  onIngest,
  onReindex,
  onDelete,
}: {
  detail: KnowledgeSourceDetailDto | null;
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  busy: boolean;
  onClose: () => void;
  onIngest: (id: string) => void;
  onReindex: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-label="Source detail"
        className="h-full w-full max-w-lg overflow-y-auto border-l bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{detail?.name ?? 'Source detail'}</h2>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {detail && (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{SOURCE_TYPE_LABELS[detail.source_type]}</Badge>
              <Badge variant={statusBadgeVariant(detail.status)}>{SOURCE_STATUS_LABELS[detail.status]}</Badge>
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Field label="Created" value={fmtDate(detail.created_at)} />
              <Field label="Updated" value={fmtDate(detail.updated_at)} />
              <Field label="Last indexed" value={detail.last_indexed_at ? fmtDate(detail.last_indexed_at) : '—'} />
              <Field label="Chunks" value={fmtNum(detail.chunk_count)} />

              {detail.source_type === 'text' && (
                <Field label="Characters" value={fmtNum(detail.preview?.characters ?? 0)} />
              )}
              {detail.source_type === 'url' && <Field label="Original URL" value={detail.url ?? '—'} />}
              {detail.source_type === 'file' && (
                <>
                  <Field label="Original filename" value={detail.original_filename ?? '—'} />
                  <Field label="File type" value={fileLabel(detail.content_type, detail.original_filename)} />
                  <Field label="Size" value={formatBytes(detail.size_bytes) ?? '—'} />
                </>
              )}
            </dl>

            {detail.error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {knowledgeErrorMessage(detail.error)}
              </div>
            )}

            <div className="grid gap-1.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Content preview</div>
              {detail.preview ? (
                <>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
                    {detail.preview.text}
                  </pre>
                  {detail.preview.truncated && (
                    <p className="text-[11px] text-muted-foreground">Preview truncated to the first characters.</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {detail.source_type === 'file'
                    ? 'The original file stays in private storage and is not previewed here.'
                    : 'No stored content to preview yet.'}
                </p>
              )}
            </div>

            <KnowledgeSourceActions
              source={detail}
              canEdit={canEdit}
              busy={busy}
              onIngest={onIngest}
              onReindex={onReindex}
              onDelete={onDelete}
            />
          </div>
        )}
      </aside>
    </div>
  );
}

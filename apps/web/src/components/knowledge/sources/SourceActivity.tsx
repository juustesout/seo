/**
 * Source Detail "Activity" section (KBUI2).
 *
 * A compact operational history built only from timestamps the API already
 * stores - no new audit log. Fetch/refresh timestamps live with the Freshness
 * facts (and its controls) so they are shown once; Activity covers the record's
 * own lifecycle.
 */
import type { KnowledgeSourceDetailDto } from '@seo/contracts';
import { fmtDate } from '@/lib/ui';
import { SourceField } from './SourceField';
import { SourceSection } from './SourceSection';

export function SourceActivity({ detail }: { detail: KnowledgeSourceDetailDto }) {
  return (
    <SourceSection title="Activity">
      <dl className="grid grid-cols-2 gap-3">
        <SourceField label="Created" value={fmtDate(detail.created_at)} />
        <SourceField label="Last processed" value={detail.last_indexed_at ? fmtDate(detail.last_indexed_at) : '—'} />
        <SourceField label="Updated" value={fmtDate(detail.updated_at)} />
      </dl>
    </SourceSection>
  );
}

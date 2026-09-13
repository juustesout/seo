/**
 * Source Detail "Freshness" section (KB7 facts, KBUI2 presentation).
 *
 * URL sources carry derived freshness facts. This section shows the state and
 * timestamps and owns the two KB7 write controls - Refresh now and the refresh
 * policy - so refresh lives with the facts it changes. After a refresh it polls
 * the source and reports the honest outcome: no change, changed/reprocessed, or
 * failed with the existing indexed content explicitly preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KNOWLEDGE_REFRESH_POLICIES,
  type KnowledgeRefreshPolicy,
  type KnowledgeSourceDetailDto,
} from '@seo/contracts';
import { api } from '../../../lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fmtDate, fmtNum } from '@/lib/ui';
import { SourceField } from './SourceField';
import { SourceSection } from './SourceSection';
import { FRESHNESS_LABELS, freshnessBadgeVariant, REFRESH_POLICY_LABELS } from '../format';

const REFRESH_POLL_MS = 400;
const REFRESH_POLL_ATTEMPTS = 75;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SourceFreshness({
  projectId,
  detail,
  canEdit,
  busy,
  onChanged,
}: {
  projectId: string;
  detail: KnowledgeSourceDetailDto;
  canEdit: boolean;
  busy: boolean;
  onChanged?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    setRefreshNotice(null);
    const previousChanged = detail.freshness?.last_changed_at ?? null;
    try {
      await api(`/projects/${projectId}/knowledge/sources/${detail.id}/refresh`, { method: 'POST', body: {} });
      setRefreshNotice('Refreshing…');
      for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS; attempt += 1) {
        await sleep(REFRESH_POLL_MS);
        if (!mounted.current) return;
        const next = await api<KnowledgeSourceDetailDto>(`/projects/${projectId}/knowledge/sources/${detail.id}`);
        if (next.status === 'queued' || next.status === 'processing') continue;
        if (!mounted.current) return;
        if (next.error && (next.freshness?.refresh_failures ?? 0) > 0) {
          setRefreshNotice('Refresh failed. Existing indexed content was preserved.');
        } else if ((next.freshness?.last_changed_at ?? null) !== previousChanged) {
          setRefreshNotice('Changes detected. The source was reprocessed.');
        } else {
          setRefreshNotice('No changes detected. The existing index was kept.');
        }
        onChanged?.();
        return;
      }
      setRefreshNotice('Still refreshing. Check back shortly.');
    } catch (e) {
      setActionError(message(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [detail, projectId, onChanged]);

  const changePolicy = useCallback(
    async (policy: KnowledgeRefreshPolicy) => {
      setPolicyBusy(true);
      setActionError(null);
      try {
        await api(`/projects/${projectId}/knowledge/sources/${detail.id}`, {
          method: 'PATCH',
          body: { refresh_policy: policy },
        });
        onChanged?.();
      } catch (e) {
        setActionError(message(e));
      } finally {
        if (mounted.current) setPolicyBusy(false);
      }
    },
    [detail, projectId, onChanged],
  );

  const freshness = detail.freshness;
  if (detail.source_type !== 'url' || !freshness) return null;

  const showRefreshFailure = Boolean(detail.error && freshness.refresh_failures > 0 && detail.status === 'ready');

  return (
    <SourceSection title="Freshness">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={freshnessBadgeVariant(freshness.state)}>{FRESHNESS_LABELS[freshness.state]}</Badge>
        <span className="text-xs text-muted-foreground">{REFRESH_POLICY_LABELS[freshness.refresh_policy ?? 'manual']}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <SourceField label="Last fetched" value={freshness.last_fetched_at ? fmtDate(freshness.last_fetched_at) : '—'} />
        <SourceField label="Last changed" value={freshness.last_changed_at ? fmtDate(freshness.last_changed_at) : '—'} />
        <SourceField
          label="Next check"
          value={freshness.next_refresh_at ? fmtDate(freshness.next_refresh_at) : 'Not scheduled'}
        />
        {freshness.refresh_failures > 0 && <SourceField label="Refresh failures" value={fmtNum(freshness.refresh_failures)} />}
      </dl>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={refreshing || busy} onClick={() => void refreshNow()}>
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Policy
            <select
              aria-label="Refresh policy"
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
              value={freshness.refresh_policy ?? 'manual'}
              disabled={policyBusy}
              onChange={(e) => void changePolicy(e.target.value as KnowledgeRefreshPolicy)}
            >
              {KNOWLEDGE_REFRESH_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {REFRESH_POLICY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {refreshNotice && <p className="text-xs text-muted-foreground">{refreshNotice}</p>}
      {showRefreshFailure && (
        <p className="text-xs text-warning">
          Refresh failed. Existing indexed content was preserved.
          {freshness.next_refresh_at ? ` Next retry: ${fmtDate(freshness.next_refresh_at)}.` : ''}
        </p>
      )}
    </SourceSection>
  );
}

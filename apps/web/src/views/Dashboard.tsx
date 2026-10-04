/**
 * Project dashboard (default project view at `/p/:id/dashboard`).
 *
 * The SEO command center: current project context, the search performance
 * numbers Google actually recorded, what needs attention, workspace coverage
 * and the top queries. Background jobs sit at the bottom as secondary
 * operational information. Everything is rendered from real provider state - a
 * search source that is off is reported as "not connected", never as a zero.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import {
  useAsync,
  fmtNum,
  fmtDate,
  useJobs,
  JobTable,
  Empty,
  SectionHeading,
  Panel,
  Divider,
  Metric,
  StatusDot,
} from '../lib/ui';
import { OnboardingChecklist } from '@/components/onboarding/OnboardingChecklist';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Dash {
  onboarding?: { dismissed: boolean };
  performance: { last_7d: number; last_28d: number; impressions_28d: number; days: number };
  counts: { keywords: number; pages: number; ranking_rows_28d: number };
  top_queries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  sources: {
    integrations: Array<{ provider_type?: string; status?: string }>;
    data_sources: Array<{ provider_type?: string; status?: string }>;
    last_sync_at: string | null;
  };
  features: Record<string, boolean>;
}

interface GscState {
  google: { connected: boolean; status: string | null };
  current: { property_id: string; site_url: string } | null;
}

/** Dashboard CTA when this project has no GSC property attached yet. */
function GscAttachCta({ projectId, onOpenSettings }: { projectId: string; onOpenSettings: () => void }) {
  const { data } = useAsync<GscState>(() => api(`/projects/${projectId}/gsc/state`), [projectId]);
  if (!data || data.current) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
      <span className="text-foreground">
        {data.google.connected
          ? 'This project has no Google Search Console property connected.'
          : 'This project is not connected to Google Search Console yet.'}
      </span>
      <Button size="sm" onClick={onOpenSettings}>
        {data.google.connected ? 'Attach GSC property' : 'Set up Search Console'}
      </Button>
    </div>
  );
}

/** A single actionable row in the "what needs attention" list. */
interface AttentionItem {
  key: string;
  text: string;
  action?: { label: string; onClick: () => void };
}

/**
 * Renders the dashboard payload from `/projects/:projectId/dashboard`.
 * `onOpenSettings` deep-links the "attach GSC property / set up Search
 * Console" CTA into the project's Settings view; `onOpenView` routes the
 * attention-list actions into the relevant project surface.
 */
export function Dashboard({
  projectId,
  role,
  onOpenSettings,
  onOpenView,
  projectName,
  websiteUrl,
}: {
  projectId: string;
  role: string;
  onOpenSettings: () => void;
  onOpenView: (view: string, sub?: string) => void;
  projectName?: string;
  websiteUrl?: string | null;
}) {
  const { data, error, loading, reload } = useAsync<Dash>(
    () => api(`/projects/${projectId}/dashboard`),
    [projectId],
  );
  const { jobs, busy } = useJobs(projectId, Boolean(data));
  const [dismissedLocal, setDismissedLocal] = useState(false);

  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const perf = data.performance;
  const feats = Object.entries(data.features)
    .filter(([, on]) => on)
    .map(([k]) => k);

  const gscActive = data.sources.data_sources.some(
    (d) => d.provider_type === 'gsc' && d.status === 'active',
  );
  const failedJobs = jobs.filter((j) => j.status === 'failed' || j.status === 'error');
  const unhealthy = data.sources.integrations.filter((i) => i.status && i.status !== 'connected');

  const attention: AttentionItem[] = [];
  if (unhealthy.length > 0) {
    attention.push({
      key: 'integrations',
      text: `${unhealthy.length} connection${unhealthy.length === 1 ? '' : 's'} need attention.`,
      action: { label: 'Open Integrations', onClick: () => onOpenView('integrations') },
    });
  }
  if (failedJobs.length > 0) {
    attention.push({
      key: 'jobs',
      text: `${failedJobs.length} background job${failedJobs.length === 1 ? '' : 's'} failed.`,
      action: { label: 'Refresh jobs', onClick: reload },
    });
  }
  if (data.counts.keywords === 0) {
    attention.push({
      key: 'keywords',
      text: 'No keywords are being tracked yet.',
      action: { label: 'Open Keywords', onClick: () => onOpenView('keywords') },
    });
  }

  const host = websiteUrl ? websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;

  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <div className="grid gap-3">
        <PageHeader
          eyebrow="Dashboard"
          title={projectName ?? 'Search overview'}
          description={
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {host ? (
                <>
                  <span>{host}</span>
                  <span className="text-border">·</span>
                </>
              ) : null}
              <span>Last synced {data.sources.last_sync_at ? fmtDate(data.sources.last_sync_at) : 'never'}</span>
              <span className="text-border">·</span>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={gscActive ? 'success' : 'neutral'} />
                Search Console {gscActive ? 'connected' : 'not connected'}
              </span>
            </span>
          }
          actions={
            <Button variant="outline" size="sm" onClick={reload}>
              Refresh
            </Button>
          }
        />
        <GscAttachCta projectId={projectId} onOpenSettings={onOpenSettings} />
      </div>

      <OnboardingChecklist
        projectId={projectId}
        role={role}
        hasSearchData={data.counts.keywords > 0 || data.top_queries.length > 0}
        dismissed={data.onboarding?.dismissed === true || dismissedLocal}
        onDismissed={() => setDismissedLocal(true)}
        onOpenView={onOpenView}
      />

      <section className="grid gap-5">
        <SectionHeading
          title="Search performance"
          description="Clicks and impressions Google Search Console recorded for this project."
        />
        {gscActive ? (
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Metric label="Clicks · last 7 days" value={fmtNum(perf.last_7d)} />
            <Metric label="Clicks · last 28 days" value={fmtNum(perf.last_28d)} />
            <Metric label="Impressions · last 28 days" value={fmtNum(perf.impressions_28d)} />
          </div>
        ) : (
          <Panel className="px-4 py-2">
            <Empty>
              Search Console is not connected, so there is no search performance to show yet.
            </Empty>
          </Panel>
        )}
      </section>

      <Divider />

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <SectionHeading title="What needs attention" />
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot tone="success" />
              Nothing needs your attention right now.
            </div>
          ) : (
            <ul className="grid gap-2.5">
              {attention.map((item) => (
                <li key={item.key} className="flex items-start justify-between gap-3 text-sm">
                  <span className="flex items-start gap-2 text-foreground">
                    <StatusDot tone="warning" className="mt-1.5" />
                    {item.text}
                  </span>
                  {item.action ? (
                    <button
                      type="button"
                      onClick={item.action.onClick}
                      className="shrink-0 text-[13px] font-medium text-primary hover:underline"
                    >
                      {item.action.label}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid content-start gap-3">
          <SectionHeading title="Coverage" description="What this workspace is tracking." />
          <div className="grid grid-cols-3 gap-4">
            <Metric label="Keywords" value={fmtNum(data.counts.keywords)} />
            <Metric label="Pages" value={fmtNum(data.counts.pages)} />
            <Metric label="Ranking rows · 28d" value={fmtNum(data.counts.ranking_rows_28d)} />
          </div>
        </div>
      </section>

      <Divider />

      <section className="grid gap-4">
        <SectionHeading
          title="Top queries"
          description="Highest-click queries in the last 28 days."
        />
        {data.top_queries.length === 0 ? (
          <Empty>No search query data yet</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Query</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">Impr.</TableHead>
                <TableHead className="text-right">Pos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.top_queries.map((q) => (
                <TableRow key={q.query}>
                  <TableCell>{q.query}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(q.clicks)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(q.impressions)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.position ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="grid gap-3">
        <SectionHeading title="Active capabilities" />
        {feats.length === 0 ? (
          <Empty>
            No data sources connected yet. Open <b>Integrations</b> to connect Search Console or DataForSEO.
          </Empty>
        ) : (
          <div className="flex flex-wrap gap-2">
            {feats.map((f) => (
              <Badge key={f} variant="success">
                {f}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <Divider />

      <section className="grid gap-3">
        <SectionHeading
          title={
            <span className="inline-flex items-center gap-2">
              Background jobs
              {busy ? <Badge variant="warning">running</Badge> : null}
            </span>
          }
          description="Operational activity for this project."
          actions={
            <Button variant="outline" size="sm" onClick={reload}>
              Refresh
            </Button>
          }
        />
        <JobTable jobs={jobs} />
      </section>
    </div>
  );
}

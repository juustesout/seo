import { api } from '../lib/api';
import { useAsync, num, fmtNum, str, fmtDate, useJobs, JobTable, StatusPill, Empty } from '../lib/ui';

interface Dash {
  performance: { last_7d: number; last_28d: number; impressions_28d: number; days: number };
  counts: { keywords: number; pages: number; ranking_rows_28d: number };
  top_queries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  sources: { integrations: any[]; data_sources: any[]; last_sync_at: string | null };
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
    <div className="banner info" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <span>
          {data.google.connected
            ? 'This project has no Google Search Console property connected.'
            : 'This project is not connected to Google Search Console yet.'}
        </span>
        <button className="btn sm primary" onClick={onOpenSettings}>
          {data.google.connected ? 'Attach GSC Property' : 'Set up Search Console'}
        </button>
      </div>
    </div>
  );
}

function Sparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  const max = Math.max(...values, 1);
  return (
    <div className="spark" style={{ height }}>
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.max((v / max) * 100, 4)}%` }} title={String(v)} />
      ))}
    </div>
  );
}

export function Dashboard({ projectId, onOpenSettings }: { projectId: string; onOpenSettings: () => void }) {
  const { data, error, loading, reload } = useAsync<Dash>(
    () => api(`/projects/${projectId}/dashboard`),
    [projectId],
  );
  const { jobs, busy } = useJobs(projectId, Boolean(data));

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return null;

  const perf = data.performance;
  const feats = Object.entries(data.features).filter(([, on]) => on).map(([k]) => k);

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="sub">
        Last sync {data.sources.last_sync_at ? fmtDate(data.sources.last_sync_at) : 'never'} ·{' '}
        {data.sources.integrations.length} integrations · {data.sources.data_sources.length} data source(s)
      </p>
      <GscAttachCta projectId={projectId} onOpenSettings={onOpenSettings} />
      <div className="grid">
        <div className="card stat">
          <div className="label">Clicks (7d)</div>
          <div className="value">{fmtNum(perf.last_7d)}</div>
        </div>
        <div className="card stat">
          <div className="label">Clicks (28d)</div>
          <div className="value">{fmtNum(perf.last_28d)}</div>
        </div>
        <div className="card stat">
          <div className="label">Impressions (28d)</div>
          <div className="value">{fmtNum(perf.impressions_28d)}</div>
        </div>
        <div className="card stat">
          <div className="label">Tracked keywords</div>
          <div className="value">{fmtNum(data.counts.keywords)}</div>
        </div>
        <div className="card stat">
          <div className="label">Pages</div>
          <div className="value">{fmtNum(data.counts.pages)}</div>
        </div>
        <div className="card stat">
          <div className="label">Ranking rows (28d)</div>
          <div className="value">{fmtNum(data.counts.ranking_rows_28d)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '1 1 320px' }}>
          <h2>Active capabilities</h2>
          {feats.length === 0 ? (
            <Empty>
              No data sources connected yet. Open <b>Integrations</b> to connect Search Console or DataForSEO.
            </Empty>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {feats.map((f) => (
                <span className="pill ok" key={f}>
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="card" style={{ flex: '1 1 320px' }}>
          <h2>Top queries (28d)</h2>
          {data.top_queries.length === 0 ? (
            <Empty>No search query data yet</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Query</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impr.</th>
                  <th className="num">Pos</th>
                </tr>
              </thead>
              <tbody>
                {data.top_queries.map((q) => (
                  <tr key={q.query}>
                    <td>{q.query}</td>
                    <td className="num">{fmtNum(q.clicks)}</td>
                    <td className="num">{fmtNum(q.impressions)}</td>
                    <td className="num">{q.position ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card mt">
        <h2>
          Background jobs {busy && <span className="pill busy">running…</span>}
          <button className="btn sm" style={{ float: 'right' }} onClick={reload}>
            Refresh
          </button>
        </h2>
        <JobTable jobs={jobs} />
      </div>
    </div>
  );
}

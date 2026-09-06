import { useState } from 'react';
import { useAsync, fmtNum, fmtDate, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';

interface GscConnection {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  last_sync_at: string | null;
  error: string | null;
}

interface ProjectSummaryRow {
  id: string;
  name: string;
  role: string;
  website_url: string | null;
  connected_count: number;
  integration_count: number;
  last_sync_at: string | null;
  created_at: string;
  property: { property_id: string; site_url: string; is_primary: boolean } | null;
}

interface AccountDto {
  account: { id: string; name: string; created_at: string };
  google: GscConnection;
  registry_count: number;
  attached_projects: number;
  projects: ProjectSummaryRow[];
  recent_activity: Array<{
    id: string;
    project_id: string | null;
    project_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    created_at: string;
    meta: Record<string, unknown>;
  }>;
}

interface AccountOverviewDto {
  connected: boolean;
  registry_count: number;
  attached_count: number;
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    clicks_trend: number | null;
    impressions_trend: number | null;
  } | null;
  series: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }> | null;
  properties: Array<{
    property_id: string;
    site_url: string;
    project_id: string;
    project_name: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }> | null;
}

function Sparkline({ values, height = 44 }: { values: number[]; height?: number }) {
  const max = Math.max(...values, 1);
  return (
    <div className="spark" style={{ height }}>
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.max((v / max) * 100, 3)}%` }} title={String(v)} />
      ))}
    </div>
  );
}

export function Overview({
  onOpenProject,
  onGoProjects,
}: {
  onOpenProject: (id: string, view: string) => void;
  onGoProjects: () => void;
}) {
  const { data, error, loading, reload } = useAsync<AccountOverviewDto>(() => api('/account/overview'), []);
  const account = useAsync<AccountDto>(() => api('/account'), []);
  const justConnected = typeof window !== 'undefined' && window.location.search.includes('gsc=connected');

  if (loading || account.loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="banner error">{error}</div>;

  const connected = data?.connected === true;
  const showOverall = Boolean(data?.totals);

  if (showOverall && data) {
    return <OverallDashboard data={data} account={account.data} onOpenProject={onOpenProject} />;
  }

  return (
    <div>
      <h1>Welcome{(account.data?.account.name ? ` to ${account.data.account.name}` : '')}</h1>
      {justConnected && <div className="banner ok">Google Search Console connected.</div>}
      <p className="sub">Manage your SEO projects from one place. Projects keep their own keywords, content and publishing; Search Console connects at the account level.</p>

      {!connected && <GoogleNotConnected />}

      {connected && data && data.attached_count === 0 && (
        <div className="banner info" style={{ marginBottom: 12 }}>
          Google Search Console is connected, but no project uses a Search Console property yet.
          Open a project below and attach a property from its <b>Settings</b> to start pulling real data.
        </div>
      )}

      <ProjectGrid projects={account.data?.projects ?? []} onOpenProject={onOpenProject} />

      {(account.data?.recent_activity?.length ?? 0) > 0 && (
        <div className="card mt">
          <h2>Recent activity</h2>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Action</th>
                <th>What</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {account.data!.recent_activity.map((a) => (
                <tr key={a.id}>
                  <td>{a.project_name ?? '—'}</td>
                  <td>
                    <StatusPill status={a.action} />
                  </td>
                  <td className="muted">{a.entity_type.replace(/^seo_/, '')}</td>
                  <td className="muted">{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(account.data?.projects?.length ?? 0) === 0 && (
        <div className="card">
          <EmptyState />
          <div className="mt">
            <button className="btn primary" onClick={onGoProjects}>
              Create your first project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return <p className="muted">You have no projects yet. Create one to start tracking keywords, rankings and content.</p>;
}

function GoogleNotConnected() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await connectGoogle();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Connect Google Search Console</h2>
      <p className="sub">
        Your Search Console connection is owned by your account. Once connected you can attach any of your Google
        properties to a project and pull real clicks, impressions and ranking data.
      </p>
      <div className="mt">
        <button className="btn primary" onClick={() => void start()} disabled={busy}>
          {busy ? 'Redirecting to Google…' : 'Connect Google Account'}
        </button>
      </div>
      {err && <div className="error-line">{err}</div>}
    </div>
  );
}

function ProjectGrid({
  projects,
  onOpenProject,
}: {
  projects: ProjectSummaryRow[];
  onOpenProject: (id: string, view: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="mt">
      <h2>Projects</h2>
      <div className="grid">
        {projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="label" style={{ fontSize: 13 }}>
              {p.property ? <span className="pill ok">{p.property.site_url}</span> : <span className="pill">no GSC property</span>}
            </div>
            <h3 style={{ margin: '6px 0' }}>{p.name}</h3>
            <p className="muted" style={{ minHeight: 36 }}>
              {p.website_url ?? 'No website set'} · role {p.role}
            </p>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {p.connected_count} connected · last sync {p.last_sync_at ? fmtDate(p.last_sync_at) : 'never'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm primary" onClick={() => onOpenProject(p.id, 'dashboard')}>
                Open dashboard
              </button>
              {!p.property && (
                <button className="btn sm" onClick={() => onOpenProject(p.id, 'settings')}>
                  Attach property
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverallDashboard({
  data,
  account,
  onOpenProject,
}: {
  data: AccountOverviewDto;
  account: AccountDto | null;
  onOpenProject: (id: string, view: string) => void;
}) {
  const totals = data.totals;
  const series = data.series ?? [];
  return (
    <div>
      <h1>Overall dashboard</h1>
      <p className="sub">
        Aggregated across {data.attached_count} project(s) · {data.registry_count} Search Console propert
        {data.registry_count === 1 ? 'y' : 'ies'} on this account
      </p>

      <div className="grid">
        <div className="card stat">
          <div className="label">Clicks</div>
          <div className="value">{fmtNum(totals?.clicks ?? 0)}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {totals?.clicks_trend != null ? `${totals.clicks_trend > 0 ? '+' : ''}${totals.clicks_trend}% vs prev` : 'no prior period'}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Impressions</div>
          <div className="value">{fmtNum(totals?.impressions ?? 0)}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {totals?.impressions_trend != null ? `${totals.impressions_trend > 0 ? '+' : ''}${totals.impressions_trend}% vs prev` : 'no prior period'}
          </div>
        </div>
        <div className="card stat">
          <div className="label">CTR</div>
          <div className="value">{fmtNum(totals?.ctr ?? 0)}%</div>
        </div>
        <div className="card stat">
          <div className="label">Avg position</div>
          <div className="value">{totals?.position ?? '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Properties</div>
          <div className="value">{fmtNum(data.properties?.length ?? 0)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '1 1 340px' }}>
          <h2>Impressions trend</h2>
          {series.length > 0 ? <Sparkline values={series.map((s) => s.impressions)} /> : <p className="muted">No daily data yet</p>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {(() => {
            const first = series[0];
            const last = series[series.length - 1];
            return first && last ? `${first.date} → ${last.date}` : '';
          })()}
          </div>
        </div>
        <div className="card" style={{ flex: '1 1 340px' }}>
          <h2>Clicks trend</h2>
          {series.length > 0 ? <Sparkline values={series.map((s) => s.clicks)} /> : <p className="muted">No daily data yet</p>}
        </div>
      </div>

      {(data.properties?.length ?? 0) > 0 && (
        <div className="card mt">
          <h2>By property</h2>
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th>Project</th>
                <th className="num">Clicks</th>
                <th className="num">Impr.</th>
                <th className="num">CTR</th>
                <th className="num">Pos</th>
              </tr>
            </thead>
            <tbody>
              {data.properties!.map((pr) => (
                <tr key={pr.property_id}>
                  <td className="mono">{pr.site_url}</td>
                  <td>
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpenProject(pr.project_id, 'dashboard'); }}>
                      {pr.project_name}
                    </a>
                  </td>
                  <td className="num">{fmtNum(pr.clicks)}</td>
                  <td className="num">{fmtNum(pr.impressions)}</td>
                  <td className="num">{pr.ctr}%</td>
                  <td className="num">{pr.position ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(account?.projects?.length ?? 0) > 0 && (
        <div className="card mt">
          <h2>Projects</h2>
          {account!.projects.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border, #eee)' }}>
              <span>
                {p.name} <span className="muted">· {p.role}</span>
              </span>
              <button className="btn sm" onClick={() => onOpenProject(p.id, 'dashboard')}>
                Open
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

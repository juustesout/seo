/**
 * Account overview (top nav "Overview").
 *
 * When at least one project has a Search Console property attached this becomes
 * an aggregate performance dashboard across attached projects; otherwise it is
 * a welcome + connect screen that walks the user through the account-level
 * Google OAuth and lists their projects and recent account activity. All
 * numbers come from the `/account` and `/account/overview` endpoints - the view
 * renders what the server measured and shows explicit empty states instead of
 * zeros when nothing is connected.
 */
import { useState } from 'react';
import { useAsync, fmtNum, fmtDate, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

/** Tiny pure bar sparkline; bar heights are normalized to the max value. */
function Sparkline({ values, height = 44 }: { values: number[]; height?: number }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-0.5" style={{ height }}>
      {values.map((v, i) => (
        <i
          key={i}
          className="min-h-0.5 flex-1 rounded-t-sm bg-primary/80"
          style={{ height: `${Math.max((v / max) * 100, 3)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  );
}

/** Compact labelled metric card shared by the overall dashboard grids. */
function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Switches between the aggregate performance dashboard and the account welcome
 * / project grid depending on whether any property is attached. Props navigate
 * to a project (`onOpenProject`) or to the Projects list (`onGoProjects`).
 */
export function Overview({
  onOpenProject,
  onGoProjects,
}: {
  onOpenProject: (id: string, view: string) => void;
  onGoProjects: () => void;
}) {
  const { data, error, loading, reload } = useAsync<AccountOverviewDto>(() => api('/account/overview'), []);
  const account = useAsync<AccountDto>(() => api('/account'), []);
  // The GSC OAuth callback redirects back here with ?gsc=connected; surface a
  // one-time confirmation banner. Reading it also implies this screen is the
  // OAuth return target, so it must be reachable while signed in.
  const justConnected = typeof window !== 'undefined' && window.location.search.includes('gsc=connected');

  if (loading || account.loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  const connected = data?.connected === true;
  const showOverall = Boolean(data?.totals);

  if (showOverall && data) {
    return <OverallDashboard data={data} account={account.data} onOpenProject={onOpenProject} />;
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        title={`Welcome${account.data?.account.name ? ` to ${account.data.account.name}` : ''}`}
        description="Manage your SEO projects from one place. Projects keep their own keywords, content and publishing; Search Console connects at the account level."
      />

      {justConnected && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          Google Search Console connected.
        </div>
      )}

      {!connected && <GoogleNotConnected />}

      {connected && data && data.attached_count === 0 && (
        <div className="rounded-lg border border-primary/20 bg-accent px-4 py-3 text-sm text-accent-foreground">
          Google Search Console is connected, but no project uses a Search Console property yet. Open a project below
          and attach a property from its <b>Settings</b> to start pulling real data.
        </div>
      )}

      <ProjectGrid projects={account.data?.projects ?? []} onOpenProject={onOpenProject} />

      {(account.data?.recent_activity?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {account.data!.recent_activity.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.project_name ?? '—'}</TableCell>
                    <TableCell>
                      <StatusPill status={a.action} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.entity_type.replace(/^seo_/, '')}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(a.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(account.data?.projects?.length ?? 0) === 0 && (
        <Card>
          <CardContent className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              You have no projects yet. Create one to start tracking keywords, rankings and content.
            </p>
            <div>
              <Button onClick={onGoProjects}>Create your first project</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** CTA card that starts the account-level Google OAuth flow in a new tab. */
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
    <Card>
      <CardHeader>
        <CardTitle>Connect Google Search Console</CardTitle>
        <p className="text-sm text-muted-foreground">
          Your Search Console connection is owned by your account. Once connected you can attach any of your Google
          properties to a project and pull real clicks, impressions and ranking data.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? 'Redirecting to Google…' : 'Connect Google Account'}
          </Button>
        </div>
        {err && <div className="text-sm text-destructive">{err}</div>}
      </CardContent>
    </Card>
  );
}

/** Card grid of the account's projects with connect/sync state and open actions. */
function ProjectGrid({
  projects,
  onOpenProject,
}: {
  projects: ProjectSummaryRow[];
  onOpenProject: (id: string, view: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="grid gap-3">
      <h2 className="text-base font-semibold">Projects</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Card key={p.id} className="flex flex-col">
            <CardHeader>
              {p.property ? (
                <Badge variant="success" className="max-w-full truncate">
                  {p.property.site_url}
                </Badge>
              ) : (
                <Badge variant="outline">no GSC property</Badge>
              )}
              <CardTitle className="text-base">{p.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {p.website_url ?? 'No website set'} · role {p.role}
              </p>
              <p className="text-xs text-muted-foreground">
                {p.connected_count} connected · last sync {p.last_sync_at ? fmtDate(p.last_sync_at) : 'never'}
              </p>
              <div className="mt-auto flex gap-2">
                <Button size="sm" onClick={() => onOpenProject(p.id, 'dashboard')}>
                  Open dashboard
                </Button>
                {!p.property && (
                  <Button size="sm" variant="outline" onClick={() => onOpenProject(p.id, 'settings')}>
                    Attach property
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Aggregate GSC performance across every attached project/property on the account. */
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
  const first = series[0];
  const last = series[series.length - 1];
  const range = first && last ? `${first.date} → ${last.date}` : '';

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Overall dashboard"
        description={`Aggregated across ${data.attached_count} project(s) · ${data.registry_count} Search Console propert${
          data.registry_count === 1 ? 'y' : 'ies'
        } on this account`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Clicks"
          value={fmtNum(totals?.clicks ?? 0)}
          hint={totals?.clicks_trend != null ? `${totals.clicks_trend > 0 ? '+' : ''}${totals.clicks_trend}% vs prev` : 'no prior period'}
        />
        <Stat
          label="Impressions"
          value={fmtNum(totals?.impressions ?? 0)}
          hint={totals?.impressions_trend != null ? `${totals.impressions_trend > 0 ? '+' : ''}${totals.impressions_trend}% vs prev` : 'no prior period'}
        />
        <Stat label="CTR" value={`${fmtNum(totals?.ctr ?? 0)}%`} />
        <Stat label="Avg position" value={totals?.position ?? '—'} />
        <Stat label="Properties" value={fmtNum(data.properties?.length ?? 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Impressions trend</CardTitle>
          </CardHeader>
          <CardContent>
            {series.length > 0 ? <Sparkline values={series.map((s) => s.impressions)} /> : <p className="text-sm text-muted-foreground">No daily data yet</p>}
            {range && <div className="mt-1.5 text-xs text-muted-foreground">{range}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Clicks trend</CardTitle>
          </CardHeader>
          <CardContent>
            {series.length > 0 ? <Sparkline values={series.map((s) => s.clicks)} /> : <p className="text-sm text-muted-foreground">No daily data yet</p>}
          </CardContent>
        </Card>
      </div>

      {(data.properties?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By property</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Impr.</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Pos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.properties!.map((pr) => (
                  <TableRow key={pr.property_id}>
                    <TableCell className="font-mono text-xs">{pr.site_url}</TableCell>
                    <TableCell>
                      <a
                        href="#"
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenProject(pr.project_id, 'dashboard');
                        }}
                      >
                        {pr.project_name}
                      </a>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(pr.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(pr.impressions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pr.ctr}%</TableCell>
                    <TableCell className="text-right tabular-nums">{pr.position ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(account?.projects?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {account!.projects.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm">
                  {p.name} <span className="text-muted-foreground">· {p.role}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => onOpenProject(p.id, 'dashboard')}>
                  Open
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Keywords & Rankings view (project nav "Data").
 *
 * A thin front over the job system: keyword research and SERP rank tracking
 * are enqueued as background jobs - never run in the browser - and their
 * results land in this project's own tables (all reads are project-scoped).
 * Results therefore never show a fake "done"; the tab states it is loading and
 * the job list below reports progress and failures honestly.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, num, fmtNum, fmtDate, useJobs, JobTable, Empty } from '../lib/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

type Tab = 'keywords' | 'pages' | 'rankings';

interface Kw {
  keyword: string;
  intent?: string | null;
  volume?: number | null;
  difficulty?: number | null;
  cpc?: number | null;
  source?: string | null;
  last_seen_at?: string | null;
}
interface Pg {
  url: string;
  title?: string | null;
  status_code?: number | null;
  word_count?: number | null;
  is_indexable?: boolean | null;
  last_seen_at?: string | null;
}
interface Rk {
  keyword: string;
  url?: string | null;
  position?: number | null;
  date?: string | null;
}

/**
 * Three-tab explorer over keywords / pages / rankings. Reads are project-scoped
 * lists fetched through lib/api.ts; the only writes are "enqueue job" calls, so
 * heavy provider work stays on the worker and the tab auto-refreshes while a
 * job is running.
 */
export function DataViews({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('keywords');
  const [refresh, setRefresh] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seeds, setSeeds] = useState('');
  const [extraKw, setExtraKw] = useState('');
  const [enqueuing, setEnqueuing] = useState<string | null>(null);
  const reload = () => setRefresh((x) => x + 1);

  const keywords = useAsync<{ keywords: Kw[]; total: number }>(
    () => api(`/projects/${projectId}/keywords?limit=200`),
    [projectId, refresh],
  );
  const pages = useAsync<{ pages: Pg[] }>(() => api(`/projects/${projectId}/pages?limit=100`), [projectId, refresh]);
  const rankings = useAsync<{ date: string | null; rankings: Rk[] }>(
    () => api(`/projects/${projectId}/rankings`),
    [projectId, refresh],
  );
  const { jobs, busy } = useJobs(projectId, true);

  // While any background job is busy, keep polling so fresh rows and job
  // progress appear without a manual refresh.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => reload(), 4000);
    return () => clearInterval(id);
  }, [busy]);

  const enqueue = async (jobType: string, params: Record<string, unknown>) => {
    setErr(null);
    setNotice(null);
    setEnqueuing(jobType);
    try {
      const r = await api<{ job: { id: string } }>(`/projects/${projectId}/jobs`, {
        method: 'POST',
        body: { job_type: jobType, params },
      });
      setNotice(`Enqueued ${jobType} (job ${r.job.id.slice(0, 8)}…)`);
      setTimeout(reload, 600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnqueuing(null);
    }
  };

  const runResearch = () => {
    const list = seeds.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!list.length) {
      setErr('Enter at least one keyword seed');
      return;
    }
    return enqueue('dataforseo_keyword_research', { seeds: list });
  };

  const runRankSync = () => {
    const extra = extraKw.split(',').map((s) => s.trim()).filter(Boolean);
    const tracked = (keywords.data?.keywords ?? []).map((k) => k.keyword);
    const list = [...extra, ...tracked].slice(0, 200);
    if (!list.length) {
      setErr('No tracked keywords and no extra keywords given');
      return;
    }
    return enqueue('serp_retrieval', { keywords: list });
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'keywords', label: `Keywords (${fmtNum(keywords.data?.total ?? 0)})` },
    { id: 'pages', label: 'Pages' },
    { id: 'rankings', label: 'Rankings' },
  ];

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Keywords & Rankings"
        description="Research and track keywords against Google via DataForSEO; results land in this project only."
      />

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Run jobs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="data-seeds">
              Keyword research seeds (one per line, max 20)
            </label>
            <Textarea
              id="data-seeds"
              value={seeds}
              onChange={(e) => setSeeds(e.target.value)}
              placeholder={'seo platform\nrank tracker'}
            />
            <div>
              <Button disabled={enqueuing !== null} onClick={() => void runResearch()}>
                {enqueuing === 'dataforseo_keyword_research' ? 'Enqueuing…' : 'Research keywords (DataForSEO)'}
              </Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="data-extra">
              Rank-tracking keywords (extra, comma separated; merges with tracked)
            </label>
            <Input
              id="data-extra"
              value={extraKw}
              onChange={(e) => setExtraKw(e.target.value)}
              placeholder="local seo tools, seo audit"
            />
            <div>
              <Button disabled={enqueuing !== null} onClick={() => void runRankSync()}>
                {enqueuing === 'serp_retrieval' ? 'Enqueuing…' : 'Track SERP positions'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-1.5">
        {tabs.map((t) => (
          <Button
            key={t.id}
            variant={tab === t.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent>
          {tab === 'keywords' && (
            <>
              {(keywords.data?.keywords ?? []).length === 0 && <Empty>No keywords yet — run a research job above.</Empty>}
              {keywords.data && keywords.data.keywords.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Volume</TableHead>
                      <TableHead className="text-right">Difficulty</TableHead>
                      <TableHead className="text-right">CPC</TableHead>
                      <TableHead>Intent</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keywords.data.keywords.map((k) => (
                      <TableRow key={k.keyword}>
                        <TableCell>{k.keyword}</TableCell>
                        <TableCell className="text-right tabular-nums">{k.volume != null ? fmtNum(k.volume) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {k.difficulty != null ? num(k.difficulty).toFixed(0) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {k.cpc != null ? `$${num(k.cpc).toFixed(2)}` : '—'}
                        </TableCell>
                        <TableCell>{k.intent || '—'}</TableCell>
                        <TableCell className="font-mono text-xs">{k.source || '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(k.last_seen_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
          {tab === 'pages' && (
            <>
              {(pages.data?.pages ?? []).length === 0 && <Empty>No pages tracked yet.</Empty>}
              {pages.data && pages.data.pages.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>URL</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                      <TableHead className="text-right">Words</TableHead>
                      <TableHead>Indexable</TableHead>
                      <TableHead>Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pages.data.pages.map((p) => (
                      <TableRow key={p.url}>
                        <TableCell className="font-mono text-xs">{p.url}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.status_code ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.word_count != null ? fmtNum(p.word_count) : '—'}
                        </TableCell>
                        <TableCell>{p.is_indexable == null ? '—' : p.is_indexable ? 'yes' : 'no'}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(p.last_seen_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
          {tab === 'rankings' && (
            <>
              {rankings.data && rankings.data.rankings.length === 0 && (
                <Empty>No ranking snapshots yet. Run “Track SERP positions” above.</Empty>
              )}
              {rankings.data && rankings.data.rankings.length > 0 && (
                <>
                  <p className="mb-2 text-sm text-muted-foreground">Snapshot date: {rankings.data.date}</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">Pos</TableHead>
                        <TableHead>Keyword</TableHead>
                        <TableHead>URL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rankings.data.rankings.map((r, i) => (
                        <TableRow key={`${r.keyword}-${i}`}>
                          <TableCell className="text-right tabular-nums">
                            {r.position && r.position <= 3 ? (
                              <b className="text-success">{r.position}</b>
                            ) : (
                              r.position ?? '—'
                            )}
                          </TableCell>
                          <TableCell>{r.keyword}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{r.url || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Recent jobs {busy ? <Badge variant="warning">working…</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable jobs={jobs} />
        </CardContent>
      </Card>
    </div>
  );
}

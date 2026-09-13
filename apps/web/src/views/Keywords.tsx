/**
 * Keywords view: two clearly separated datasets in one workspace.
 *
 *   Research  - DataForSEO keyword research (KW2). One seed keyword starts one
 *               background job through the API; the run's own bounded result is
 *               read back by job id, so the panel only ever shows the results of
 *               the run the user started. It never guesses from the shared
 *               keyword store and never talks to a provider from the browser.
 *   My keywords - the queries Google Search Console reports for this project's
 *               linked property, a pure read of already-synced GSC data through
 *               `/projects/:id/gsc/keywords`.
 *
 * The two are deliberately not mixed: research metrics (volume/difficulty/cpc)
 * are not GSC performance, and vice versa.
 */
import { useEffect, useState } from 'react';
import { useAsync, num, fmtNum, fmtDate } from '../lib/ui';
import { api, ApiRequestError } from '../lib/api';
import { COMPETITOR_RESEARCH_MAX_COMPETITORS } from '@seo/contracts';
import type {
  CompetitorDiscoveryStartDto,
  CompetitorGapStartDto,
  CompetitorResearchRunDto,
  KeywordDto,
  KeywordResearchRunDto,
  KeywordResearchStartDto,
  ProjectKeywordsDto,
} from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** CTR is a 0..1 fraction from GSC; render it as a percentage. */
function fmtCtr(v: unknown): string {
  return `${(num(v) * 100).toFixed(2)}%`;
}

/** Weighted average position, limited to one decimal for readability. */
function fmtPosition(v: unknown): string {
  return num(v).toFixed(1);
}

/** Editors and above may start provider work; viewers never can. */
function canStartResearch(role: string): boolean {
  return role === 'editor' || role === 'admin' || role === 'owner';
}

/** Format a nullable research metric (volume/difficulty/cpc). */
function fmtMetric(v: number | null, kind: 'int' | 'money'): string {
  if (v == null) return '—';
  return kind === 'money' ? `$${num(v).toFixed(2)}` : fmtNum(v);
}

function ResearchResults({ run }: { run: KeywordResearchRunDto }) {
  if (run.status === 'queued' || run.status === 'running') {
    return <div className="py-6 text-center text-sm text-muted-foreground">Researching keywords…</div>;
  }
  if (run.status === 'failed') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {run.error ?? 'Keyword research failed. Please try again.'}
      </div>
    );
  }
  if (run.status === 'canceled') {
    return <div className="py-6 text-center text-sm text-muted-foreground">This research run was canceled.</div>;
  }
  if (run.keywords.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No keywords were found for “{run.seed}”.
      </div>
    );
  }
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        {fmtNum(run.results)} result{run.results === 1 ? '' : 's'} for “{run.seed}” · Google · United States · English
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Keyword</TableHead>
            <TableHead className="text-right">Volume</TableHead>
            <TableHead className="text-right">Difficulty</TableHead>
            <TableHead className="text-right">CPC</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {run.keywords.map((k) => (
            <TableRow key={k.keyword}>
              <TableCell className="max-w-[28rem] truncate font-medium" title={k.keyword}>
                {k.keyword}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtMetric(k.searchVolume, 'int')}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMetric(k.difficulty, 'int')}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMetric(k.cpc, 'money')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function KeywordResearch({ projectId, role }: { projectId: string; role: string }) {
  const [seed, setSeed] = useState('');
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<KeywordResearchRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the specific run while it is in flight; stop once it is terminal so an
  // idle panel never polls forever.
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await api<KeywordResearchRunDto>(`/projects/${projectId}/keyword/research/${run.jobId}`);
        if (alive) setRun(next);
      } catch {
        /* transient poll error: the next tick retries */
      }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.jobId, run?.status, projectId]);

  const start = async () => {
    const trimmed = seed.trim();
    if (!trimmed) {
      setError('Enter a keyword to research');
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const started = await api<KeywordResearchStartDto>(`/projects/${projectId}/keyword/research`, {
        method: 'POST',
        body: { seed: trimmed },
      });
      setRun({
        jobId: started.jobId,
        seed: started.seed,
        status: started.status,
        results: 0,
        keywords: [],
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'not_configured') {
        setError('Keyword research is not configured.');
      } else if (e instanceof ApiRequestError && e.code === 'forbidden') {
        setError('You do not have permission to start keyword research.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not start keyword research. Please try again.');
      }
    } finally {
      setStarting(false);
    }
  };

  const allowed = canStartResearch(role);
  const inFlight = run?.status === 'queued' || run?.status === 'running';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Research</CardTitle>
        <CardDescription>
          Discover related keywords for a seed via DataForSEO. Results are shown for this run only.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!allowed && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Only editors and above can start keyword research.
          </div>
        )}
        <div className="grid gap-1.5">
          <label className="text-sm font-medium" htmlFor="keyword-research-seed">
            Seed keyword
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="keyword-research-seed"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && allowed && !starting && !inFlight) void start();
              }}
              placeholder="seo software"
              disabled={!allowed || inFlight}
              className="max-w-sm"
            />
            <Button disabled={!allowed || starting || inFlight || !seed.trim()} onClick={() => void start()}>
              {starting || inFlight ? 'Researching…' : 'Start research'}
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {!error && !run && (
          <div className="py-6 text-center text-sm text-muted-foreground">Enter a keyword to research.</div>
        )}

        {run && !error && <ResearchResults run={run} />}
      </CardContent>
    </Card>
  );
}

/**
 * Poll a competitor run by id while it is in flight; stop once it is terminal
 * so an idle panel never polls forever.
 */
function useRunPoll(
  projectId: string,
  run: CompetitorResearchRunDto | null,
  setRun: (next: CompetitorResearchRunDto) => void,
) {
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await api<CompetitorResearchRunDto>(`/projects/${projectId}/keyword/competitors/${run.jobId}`);
        if (alive) setRun(next);
      } catch {
        /* transient poll error: the next tick retries */
      }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.jobId, run?.status, projectId]);
}

/** Format a nullable competitor/gap metric (never fabricate a zero). */
function fmtNullable(v: number | null, kind: 'int' | 'money' = 'int'): string {
  if (v == null) return '—';
  return kind === 'money' ? `$${num(v).toFixed(2)}` : fmtNum(v);
}

/**
 * Competitors workspace (KW3): discover peers for the project's domain, select
 * up to the cap, then analyze page-one keyword gaps. Both operations are backed
 * by the existing competitor_research job; the panel reads back exactly the run
 * it started and never guesses from the shared keyword store.
 */
function CompetitorResearch({ projectId, role }: { projectId: string; role: string }) {
  const [discovery, setDiscovery] = useState<CompetitorResearchRunDto | null>(null);
  const [gapRun, setGapRun] = useState<CompetitorResearchRunDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useRunPoll(projectId, discovery, setDiscovery);
  useRunPoll(projectId, gapRun, setGapRun);

  /** Map a start failure to an honest, non-leaking message. */
  const startError = (e: unknown, fallback: string): string => {
    if (e instanceof ApiRequestError) {
      if (e.code === 'not_configured') return 'Competitor research is not configured.';
      if (e.code === 'forbidden') return 'You do not have permission to run competitor research.';
      return e.message;
    }
    return fallback;
  };

  const findCompetitors = async () => {
    setError(null);
    setGapRun(null);
    setSelected([]);
    setDiscovering(true);
    try {
      const started = await api<CompetitorDiscoveryStartDto>(`/projects/${projectId}/keyword/competitors`, {
        method: 'POST',
      });
      setDiscovery({
        jobId: started.jobId,
        mode: 'discover',
        status: started.status,
        domain: started.domain,
        candidates: [],
        selectedCompetitors: [],
        gaps: [],
        count: 0,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    } catch (e) {
      setError(startError(e, 'Could not find competitors. Please try again.'));
    } finally {
      setDiscovering(false);
    }
  };

  const analyze = async () => {
    if (selected.length === 0) {
      setError('Select at least one competitor to analyze');
      return;
    }
    setError(null);
    setAnalyzing(true);
    try {
      const started = await api<CompetitorGapStartDto>(`/projects/${projectId}/keyword/competitor-gap`, {
        method: 'POST',
        body: { competitors: selected },
      });
      setGapRun({
        jobId: started.jobId,
        mode: 'gap',
        status: started.status,
        domain: started.domain,
        candidates: [],
        selectedCompetitors: started.competitors,
        gaps: [],
        count: 0,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    } catch (e) {
      setError(startError(e, 'Could not start the gap analysis. Please try again.'));
    } finally {
      setAnalyzing(false);
    }
  };

  const toggle = (domain: string) => {
    setSelected((prev) =>
      prev.includes(domain)
        ? prev.filter((d) => d !== domain)
        : prev.length >= COMPETITOR_RESEARCH_MAX_COMPETITORS
          ? prev
          : [...prev, domain],
    );
  };

  const allowed = canStartResearch(role);
  const discoveryInFlight = discovery?.status === 'queued' || discovery?.status === 'running';
  const gapInFlight = gapRun?.status === 'queued' || gapRun?.status === 'running';
  const candidates = discovery?.status === 'completed' ? discovery.candidates : [];
  const gaps = gapRun?.status === 'completed' ? gapRun.gaps : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Competitors</CardTitle>
        <CardDescription>
          Find who competes with your domain, then see the keywords they rank for that you do not.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!allowed && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Only editors and above can run competitor research.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!allowed || discovering || discoveryInFlight} onClick={() => void findCompetitors()}>
            {discovering || discoveryInFlight ? 'Finding competitors…' : 'Find competitors'}
          </Button>
          {discovery?.domain && (
            <span className="text-sm text-muted-foreground">
              Your domain: <span className="font-medium text-foreground">{discovery.domain}</span>
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {discovery?.status === 'failed' && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {discovery.error ?? 'Competitor discovery failed. Please try again.'}
          </div>
        )}

        {!discovery && !error && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Find competitors for this project&apos;s domain.
          </div>
        )}

        {discovery?.status === 'completed' && candidates.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No competitor domains were found for {discovery.domain}.
          </div>
        )}

        {candidates.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Select up to {COMPETITOR_RESEARCH_MAX_COMPETITORS} competitors to analyze.
              </p>
              <span className="text-xs text-muted-foreground">{selected.length} selected</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Competitor</TableHead>
                  <TableHead className="text-right">Shared keywords</TableHead>
                  <TableHead className="text-right">Keywords</TableHead>
                  <TableHead className="text-right">Avg. position</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => {
                  const checked = selected.includes(c.domain);
                  const atLimit = !checked && selected.length >= COMPETITOR_RESEARCH_MAX_COMPETITORS;
                  return (
                    <TableRow key={c.domain}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.domain}`}
                          checked={checked}
                          disabled={!allowed || gapInFlight || atLimit}
                          onChange={() => toggle(c.domain)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{c.domain}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNullable(c.sharedKeywords)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNullable(c.keywordsCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.avgPosition == null ? '—' : num(c.avgPosition).toFixed(1)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div>
              <Button disabled={!allowed || gapInFlight || selected.length === 0} onClick={() => void analyze()}>
                {gapInFlight ? 'Analyzing…' : 'Analyze keyword gaps'}
              </Button>
            </div>
          </>
        )}

        {gapRun?.status === 'failed' && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {gapRun.error ?? 'Keyword gap analysis failed. Please try again.'}
          </div>
        )}

        {gapInFlight && (
          <div className="py-6 text-center text-sm text-muted-foreground">Analyzing keyword gaps…</div>
        )}

        {gapRun?.status === 'completed' && gaps.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No page-one keyword gaps were found for the selected competitors.
          </div>
        )}

        {gaps.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {fmtNum(gapRun?.count ?? gaps.length)} gap{gaps.length === 1 ? '' : 's'} · Google · United States · English
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Keyword</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                  <TableHead className="text-right">Difficulty</TableHead>
                  <TableHead className="text-right">CPC</TableHead>
                  <TableHead>Competitor</TableHead>
                  <TableHead className="text-right">Rank</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gaps.map((g, i) => (
                  <TableRow key={`${g.keyword}-${g.competitorDomain}-${i}`}>
                    <TableCell className="max-w-[26rem] truncate font-medium" title={g.keyword}>
                      {g.keyword}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNullable(g.searchVolume)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNullable(g.difficulty)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNullable(g.cpc, 'money')}</TableCell>
                    <TableCell>{g.competitorDomain}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNullable(g.position)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GscKeywordTable({ keywords }: { keywords: KeywordDto[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Query</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
          <TableHead className="text-right">Impressions</TableHead>
          <TableHead className="text-right">CTR</TableHead>
          <TableHead className="text-right">Position</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keywords.map((k) => (
          <TableRow key={k.keyword}>
            <TableCell className="max-w-[28rem] truncate font-medium" title={k.keyword}>
              {k.keyword}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(k.clicks)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(k.impressions)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtCtr(k.ctr)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtPosition(k.position)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type KeywordsTab = 'mine' | 'research' | 'competitors';

const KEYWORDS_TABS: Array<{ id: KeywordsTab; label: string }> = [
  { id: 'mine', label: 'My keywords' },
  { id: 'research', label: 'Research' },
  { id: 'competitors', label: 'Competitors' },
];

export function Keywords({ projectId, role }: { projectId: string; role: string }) {
  const [tab, setTab] = useState<KeywordsTab>('mine');
  const { data, error, loading } = useAsync<ProjectKeywordsDto>(
    () => api(`/projects/${projectId}/gsc/keywords`),
    [projectId],
  );

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Keywords"
        description="Research new keyword opportunities, find competitor gaps, and see the queries your site is already seen for in Google Search Console."
      />

      <div className="flex flex-wrap gap-2">
        {KEYWORDS_TABS.map((t) => (
          <Button key={t.id} variant={tab === t.id ? 'default' : 'outline'} size="sm" onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
      </div>

      {tab === 'research' && <KeywordResearch projectId={projectId} role={role} />}
      {tab === 'competitors' && <CompetitorResearch projectId={projectId} role={role} />}

      {tab === 'mine' && (
        <Card>
          <CardHeader>
            <CardTitle>My keywords</CardTitle>
            <CardDescription>
              Queries your site is seen for in Google Search Console, and how they perform over the last 28 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && <div className="py-10 text-center text-sm text-muted-foreground">Loading keywords…</div>}

            {!loading && error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Could not load keyword data. Please try again.
              </div>
            )}

            {!loading && !error && data && (
              <>
                {!data.propertyId && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    Google Search Console is not connected to this project.
                  </div>
                )}

                {data.propertyId && data.keywords.length === 0 && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No keyword data is available yet. Run a Google Search Console sync first.
                  </div>
                )}

                {data.propertyId && data.keywords.length > 0 && (
                  <>
                    {data.lastSyncedAt && (
                      <p className="mb-3 text-xs text-muted-foreground">Last synced {fmtDate(data.lastSyncedAt)}</p>
                    )}
                    <GscKeywordTable keywords={data.keywords} />
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

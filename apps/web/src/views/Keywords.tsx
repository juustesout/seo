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
import {
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  KEYWORD_EXPANSION_MAX_SEEDS,
  KEYWORD_EXPANSION_METHODS,
  OPPORTUNITY_INTENTS,
  OPPORTUNITY_SORTS,
  OPPORTUNITY_SORT_DIRS,
} from '@seo/contracts';
import type {
  CompetitorDiscoveryStartDto,
  CompetitorGapStartDto,
  CompetitorResearchRunDto,
  KeywordDto,
  KeywordExpansionMethod,
  KeywordExpansionRunDto,
  KeywordExpansionSaveDto,
  KeywordExpansionStartDto,
  KeywordQuery,
  KeywordResearchRunDto,
  KeywordResearchStartDto,
  OpportunitiesDto,
  OpportunityIntent,
  OpportunityReason,
  OpportunitySort,
  OpportunitySortDir,
  ProjectKeywordsDto,
  SourceSnapshotDto,
  SourceSnapshotFreshnessState,
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
 * so an idle panel never polls forever. `onDone` fires once on terminal status
 * so the caller can refresh the (free) source snapshot it is displaying.
 */
function useRunPoll(
  projectId: string,
  run: CompetitorResearchRunDto | null,
  setRun: (next: CompetitorResearchRunDto) => void,
  onDone?: (done: CompetitorResearchRunDto) => void,
) {
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    let alive = true;
    let done = false;
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      try {
        const next = await api<CompetitorResearchRunDto>(`/projects/${projectId}/keyword/competitors/${run.jobId}`);
        if (!alive) return;
        setRun(next);
        if (next.status === 'completed' || next.status === 'failed') {
          done = true;
          if (id !== undefined) clearInterval(id);
          onDone?.(next);
        }
      } catch {
        /* transient poll error: the next tick retries */
      }
    };
    void tick();
    id = setInterval(() => {
      if (!done) void tick();
    }, 2500);
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

/** Human age of a snapshot, coarse on purpose (never invents precision). */
function fmtAge(ms: number | null): string {
  if (ms == null) return 'age unknown';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

/** Plain-language labels for the derived snapshot freshness states. */
const SNAPSHOT_FRESHNESS_LABELS: Record<SourceSnapshotFreshnessState, string> = {
  fresh: 'Up to date',
  due: 'Aging',
  stale: 'Out of date',
  unknown: 'Unverified',
};

/**
 * Competitors workspace (KW3): discover peers for the project's domain, select
 * up to the cap, then analyze page-one keyword gaps. Both operations are backed
 * by the existing competitor_research job, but reads are answered from the
 * project's saved source snapshots (KW4.5): opening the tab or inspecting a
 * snapshot never calls a provider. Only the explicit Find/Refresh/Analyze
 * buttons may start a paid run, and a fresh snapshot is reused instead of
 * re-paying. The server derives freshness; a stale snapshot stays visible with
 * its age and a Refresh action rather than disappearing.
 */
function CompetitorResearch({ projectId, role }: { projectId: string; role: string }) {
  const [discovery, setDiscovery] = useState<CompetitorResearchRunDto | null>(null);
  const [discoverySnapshot, setDiscoverySnapshot] = useState<SourceSnapshotDto | null>(null);
  const [gapRun, setGapRun] = useState<CompetitorResearchRunDto | null>(null);
  const [gapSnapshot, setGapSnapshot] = useState<SourceSnapshotDto | null>(null);
  const [gapSnapshotFor, setGapSnapshotFor] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDiscoverySnapshot = async (): Promise<void> => {
    try {
      const next = await api<SourceSnapshotDto | null>(`/projects/${projectId}/keyword/competitors/snapshot`);
      setDiscoverySnapshot(next);
    } catch {
      /* a free snapshot read must never block the workspace */
    }
  };

  const loadGapSnapshot = async (competitors: string[]): Promise<void> => {
    if (competitors.length === 0) {
      setGapSnapshot(null);
      setGapSnapshotFor([]);
      return;
    }
    try {
      const query = encodeURIComponent(competitors.join(','));
      const next = await api<SourceSnapshotDto | null>(
        `/projects/${projectId}/keyword/competitor-gap/snapshot?competitors=${query}`,
      );
      setGapSnapshot(next);
      setGapSnapshotFor([...competitors].sort());
    } catch {
      /* a free snapshot read must never block the workspace */
    }
  };

  useEffect(() => {
    void loadDiscoverySnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useRunPoll(projectId, discovery, setDiscovery, () => {
    void loadDiscoverySnapshot();
  });
  useRunPoll(projectId, gapRun, setGapRun, (done) => {
    void loadGapSnapshot(done.selectedCompetitors);
  });

  /** Map a start failure to an honest, non-leaking message. */
  const startError = (e: unknown, fallback: string): string => {
    if (e instanceof ApiRequestError) {
      if (e.code === 'not_configured') return 'Competitor research is not configured.';
      if (e.code === 'forbidden') return 'You do not have permission to run competitor research.';
      return e.message;
    }
    return fallback;
  };

  const findCompetitors = async (refresh: boolean) => {
    setError(null);
    setNotice(null);
    setDiscovering(true);
    try {
      const started = await api<CompetitorDiscoveryStartDto>(`/projects/${projectId}/keyword/competitors`, {
        method: 'POST',
        body: { refresh },
      });
      if (started.reused) {
        setNotice('Showing the saved competitor snapshot - no provider call was made.');
        await loadDiscoverySnapshot();
        return;
      }
      if (!started.jobId) throw new Error('missing job id');
      setGapRun(null);
      setGapSnapshot(null);
      setGapSnapshotFor([]);
      setSelected([]);
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

  const analyze = async (refresh: boolean) => {
    if (selected.length === 0) {
      setError('Select at least one competitor to analyze');
      return;
    }
    setError(null);
    setNotice(null);
    setAnalyzing(true);
    try {
      const started = await api<CompetitorGapStartDto>(`/projects/${projectId}/keyword/competitor-gap`, {
        method: 'POST',
        body: { competitors: selected, refresh },
      });
      if (started.reused) {
        setNotice('Showing the saved gap snapshot - no provider call was made.');
        await loadGapSnapshot(started.competitors);
        return;
      }
      if (!started.jobId) throw new Error('missing job id');
      setGapSnapshot(null);
      setGapSnapshotFor([]);
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
  const runCandidates = discovery?.status === 'completed' ? discovery.candidates : [];
  const candidates = discoverySnapshot && discoverySnapshot.candidates.length > 0 ? discoverySnapshot.candidates : runCandidates;
  const runGaps = gapRun?.status === 'completed' ? gapRun.gaps : [];
  const gaps = gapSnapshot && gapSnapshot.gaps.length > 0 ? gapSnapshot.gaps : runGaps;
  const gapCount = gapSnapshot?.count ?? gapRun?.count ?? gaps.length;
  const gapSnapshotVisible = gapSnapshot !== null && gapSnapshotFor.join(',') === [...selected].sort().join(',');
  const discoveryDomain =
    typeof discoverySnapshot?.scope.domain === 'string' ? discoverySnapshot.scope.domain : discovery?.domain;

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
          <Button disabled={!allowed || discovering || discoveryInFlight} onClick={() => void findCompetitors(false)}>
            {discovering || discoveryInFlight ? 'Finding competitors…' : 'Find competitors'}
          </Button>
          {discovery?.domain && (
            <span className="text-sm text-muted-foreground">
              Your domain: <span className="font-medium text-foreground">{discovery.domain}</span>
            </span>
          )}
        </div>

        {discoverySnapshot && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Competitor snapshot from {fmtDate(discoverySnapshot.fetchedAt)} ·{' '}
              <span className="font-medium text-foreground">
                {SNAPSHOT_FRESHNESS_LABELS[discoverySnapshot.freshness.state]}
              </span>{' '}
              · {fmtAge(discoverySnapshot.freshness.age_ms)}
            </span>
            {allowed && (
              <Button
                variant="outline"
                size="sm"
                disabled={discovering || discoveryInFlight}
                onClick={() => void findCompetitors(true)}
              >
                Refresh
              </Button>
            )}
          </div>
        )}

        {notice && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{notice}</div>
        )}

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

        {!discovery && !discoverySnapshot && !error && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Find competitors for this project&apos;s domain.
          </div>
        )}

        {candidates.length === 0 && !discoveryInFlight && !discovering && (discovery?.status === 'completed' || discoverySnapshot) && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No competitor domains were found for {discoveryDomain}.
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
              <Button disabled={!allowed || gapInFlight || selected.length === 0} onClick={() => void analyze(false)}>
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

        {gapSnapshotVisible && gapSnapshot && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Gap snapshot from {fmtDate(gapSnapshot.fetchedAt)} ·{' '}
              <span className="font-medium text-foreground">
                {SNAPSHOT_FRESHNESS_LABELS[gapSnapshot.freshness.state]}
              </span>{' '}
              · {fmtAge(gapSnapshot.freshness.age_ms)}
            </span>
            {allowed && (
              <Button variant="outline" size="sm" disabled={gapInFlight || analyzing} onClick={() => void analyze(true)}>
                Refresh
              </Button>
            )}
          </div>
        )}

        {gaps.length === 0 && !gapInFlight && !analyzing && (gapRun?.status === 'completed' || gapSnapshotVisible) && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No page-one keyword gaps were found for the selected competitors.
          </div>
        )}

        {gaps.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {fmtNum(gapCount)} gap{gaps.length === 1 ? '' : 's'} · Google · United States · English
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

const EXPANSION_METHOD_LABELS: Record<KeywordExpansionMethod, string> = {
  suggestions: 'Suggestions',
  related: 'Related',
  ideas: 'Ideas',
};

/**
 * Keyword expansion workspace (KW4): discover -> review -> select -> save.
 *
 * One run combines an explicit set of methods on the existing keyword-research
 * job and returns a bounded snapshot. The provider-side "minimum volume" field
 * is a discovery filter (it changes what the run fetches); the result-view
 * filters narrow the stored snapshot and never start a provider call. Only an
 * explicit, checked selection is saved, and the server derives its provenance.
 */
function KeywordExpansion({ projectId, role }: { projectId: string; role: string }) {
  const [seedsText, setSeedsText] = useState('');
  const [methods, setMethods] = useState<KeywordExpansionMethod[]>(['suggestions']);
  const [providerMinVolume, setProviderMinVolume] = useState('');
  const [run, setRun] = useState<KeywordExpansionRunDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [minVolume, setMinVolume] = useState('');
  const [methodFilter, setMethodFilter] = useState<'all' | KeywordExpansionMethod>('all');
  const [sort, setSort] = useState<KeywordQuery['sort']>('volume_desc');

  // Poll the specific run while it is in flight; stop once it is terminal.
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await api<KeywordExpansionRunDto>(`/projects/${projectId}/keyword/expansion/${run.jobId}`);
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

  // Re-read the completed run through the result-view filters. This only
  // narrows a stored snapshot; it never asks the provider for anything.
  useEffect(() => {
    if (!run || run.status !== 'completed') return;
    const params = new URLSearchParams();
    if (minVolume.trim()) params.set('minVolume', minVolume.trim());
    if (methodFilter !== 'all') params.set('method', methodFilter);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    let alive = true;
    api<KeywordExpansionRunDto>(`/projects/${projectId}/keyword/expansion/${run.jobId}${qs ? `?${qs}` : ''}`)
      .then((next) => {
        if (alive) setRun((cur) => (cur && cur.jobId === next.jobId ? next : cur));
      })
      .catch(() => {
        /* keep showing the snapshot already loaded */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.jobId, run?.status, minVolume, methodFilter, sort, projectId]);

  const toggleMethod = (method: KeywordExpansionMethod) => {
    setMethods((prev) => (prev.includes(method) ? prev.filter((m) => m !== method) : [...prev, method]));
  };

  const start = async () => {
    const seeds = seedsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (seeds.length === 0) {
      setError('Enter at least one seed keyword');
      return;
    }
    if (seeds.length > KEYWORD_EXPANSION_MAX_SEEDS) {
      setError(`Expand at most ${KEYWORD_EXPANSION_MAX_SEEDS} seeds per run`);
      return;
    }
    if (methods.length === 0) {
      setError('Select at least one method');
      return;
    }
    setError(null);
    setNotice(null);
    setSelected([]);
    setStarting(true);
    try {
      const body: Record<string, unknown> = { seeds, methods };
      if (providerMinVolume.trim()) body.providerMinVolume = Number(providerMinVolume.trim());
      const started = await api<KeywordExpansionStartDto>(`/projects/${projectId}/keyword/expansion`, {
        method: 'POST',
        body,
      });
      setRun({
        jobId: started.jobId,
        status: started.status,
        seeds: started.seeds,
        methods: started.methods,
        methodStatus: {},
        candidates: [],
        count: 0,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'not_configured') setError('Keyword expansion is not configured.');
      else if (e instanceof ApiRequestError && e.code === 'forbidden') setError('You do not have permission to run keyword expansion.');
      else setError(e instanceof Error ? e.message : 'Could not start keyword expansion. Please try again.');
    } finally {
      setStarting(false);
    }
  };

  const save = async () => {
    if (!run || selected.length === 0) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const out = await api<KeywordExpansionSaveDto>(`/projects/${projectId}/keyword/expansion/${run.jobId}/save`, {
        method: 'POST',
        body: { keywords: selected },
      });
      setNotice(`Saved ${out.saved} keyword${out.saved === 1 ? '' : 's'}${out.skipped ? ` (${out.skipped} duplicate skipped)` : ''}.`);
      setSelected([]);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'forbidden') setError('You do not have permission to save keywords.');
      else setError(e instanceof Error ? e.message : 'Could not save keywords. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const toggleSelection = (keyword: string) => {
    setSelected((prev) => (prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword]));
  };

  const allowed = canStartResearch(role);
  const inFlight = run?.status === 'queued' || run?.status === 'running';
  const candidates = run?.status === 'completed' ? run.candidates : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Expand</CardTitle>
        <CardDescription>
          Discover related, suggested and idea keywords for one or more seeds, review the run, then save only the
          keywords you choose.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!allowed && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Only editors and above can run keyword expansion.
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="keyword-expansion-seeds">
              Seed keywords
            </label>
            <Input
              id="keyword-expansion-seeds"
              value={seedsText}
              onChange={(e) => setSeedsText(e.target.value)}
              placeholder="seo software, keyword research"
              disabled={!allowed || inFlight}
            />
            <p className="text-xs text-muted-foreground">Comma-separated, up to {KEYWORD_EXPANSION_MAX_SEEDS} seeds.</p>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="keyword-expansion-min-volume">
              Provider minimum volume
            </label>
            <Input
              id="keyword-expansion-min-volume"
              type="number"
              min={0}
              value={providerMinVolume}
              onChange={(e) => setProviderMinVolume(e.target.value)}
              placeholder="No minimum"
              disabled={!allowed || inFlight}
            />
            <p className="text-xs text-muted-foreground">Discovery filter: narrows what the run fetches from the provider.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {KEYWORD_EXPANSION_METHODS.map((method) => (
            <label key={method} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={methods.includes(method)}
                disabled={!allowed || inFlight}
                onChange={() => toggleMethod(method)}
              />
              {EXPANSION_METHOD_LABELS[method]}
            </label>
          ))}
          <Button disabled={!allowed || starting || inFlight || !seedsText.trim() || methods.length === 0} onClick={() => void start()}>
            {starting || inFlight ? 'Expanding…' : 'Start expansion'}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {!error && !run && (
          <div className="py-6 text-center text-sm text-muted-foreground">Enter seed keywords to expand.</div>
        )}

        {run?.status === 'failed' && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {run.error ?? 'Keyword expansion failed. Please try again.'}
          </div>
        )}

        {run && (run.status === 'queued' || run.status === 'running') && (
          <div className="py-6 text-center text-sm text-muted-foreground">Expanding keywords…</div>
        )}

        {run?.status === 'completed' && (
          <>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {run.methods.map((method) => {
                const status = run.methodStatus[method];
                if (!status) return null;
                const label = EXPANSION_METHOD_LABELS[method];
                return (
                  <span key={method} className="rounded-md border px-2 py-1">
                    {status.status === 'failed'
                      ? `${label}: failed`
                      : status.status === 'skipped'
                        ? `${label}: skipped`
                        : `${label}: ${fmtNum(status.count)}`}
                  </span>
                );
              })}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <label className="text-xs font-medium" htmlFor="keyword-expansion-view-min">
                  Show minimum volume
                </label>
                <Input
                  id="keyword-expansion-view-min"
                  type="number"
                  min={0}
                  value={minVolume}
                  onChange={(e) => setMinVolume(e.target.value)}
                  placeholder="Any"
                  className="w-32"
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium" htmlFor="keyword-expansion-view-method">
                  Method
                </label>
                <select
                  id="keyword-expansion-view-method"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value as 'all' | KeywordExpansionMethod)}
                >
                  <option value="all">All</option>
                  {KEYWORD_EXPANSION_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {EXPANSION_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium" htmlFor="keyword-expansion-view-sort">
                  Sort
                </label>
                <select
                  id="keyword-expansion-view-sort"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as KeywordQuery['sort'])}
                >
                  <option value="volume_desc">Volume high to low</option>
                  <option value="volume_asc">Volume low to high</option>
                  <option value="keyword_asc">Keyword A-Z</option>
                </select>
              </div>
            </div>

            {candidates.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No candidates match these filters.</div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {fmtNum(candidates.length)} candidate{candidates.length === 1 ? '' : 's'} · select the ones to save.
                  </p>
                  <span className="text-xs text-muted-foreground">{selected.length} selected</span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Volume</TableHead>
                      <TableHead className="text-right">Difficulty</TableHead>
                      <TableHead className="text-right">CPC</TableHead>
                      <TableHead>Methods</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map((c) => (
                      <TableRow key={c.keyword}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.keyword}`}
                            checked={selected.includes(c.keyword)}
                            disabled={!allowed || saving}
                            onChange={() => toggleSelection(c.keyword)}
                          />
                        </TableCell>
                        <TableCell className="max-w-[26rem] truncate font-medium" title={c.keyword}>
                          {c.keyword}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(c.searchVolume, 'int')}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(c.difficulty, 'int')}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(c.cpc, 'money')}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.methods.map((m) => EXPANSION_METHOD_LABELS[m]).join(', ')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div>
                  <Button disabled={!allowed || saving || selected.length === 0} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save selected'}
                  </Button>
                </div>
              </>
            )}
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

const OPPORTUNITY_REASON_LABELS: Record<OpportunityReason, string> = {
  high_volume: 'High volume',
  low_difficulty: 'Low difficulty',
  commercial_value: 'Commercial signal',
  multiple_competitors_rank: 'Multiple competitors rank',
  top_competitor_rank: 'Top competitor rank',
};

const OPPORTUNITY_INTENT_LABELS: Record<OpportunityIntent, string> = {
  informational: 'Informational',
  commercial: 'Commercial',
  transactional: 'Transactional',
  navigational: 'Navigational',
};

const OPPORTUNITY_SORT_LABELS: Record<OpportunitySort, string> = {
  score: 'Score',
  volume: 'Volume',
  difficulty: 'Difficulty',
  keyword: 'Keyword',
};

const OPPORTUNITY_SORT_DIR_LABELS: Record<OpportunitySortDir, string> = {
  desc: 'Descending',
  asc: 'Ascending',
};

const SELECT_CLASS =
  'h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

/**
 * KW5: a deterministic, explainable read over the project's current-best-known
 * competitor gap snapshot. It never starts provider work - when no gap snapshot
 * exists it points the user at the Competitors tab instead. Every row shows why
 * it scored the way it did; a missing metric renders as a dash, never a zero.
 */
function Opportunities({ projectId, onGoToCompetitors }: { projectId: string; onGoToCompetitors: () => void }) {
  const [minVolume, setMinVolume] = useState('');
  const [maxDifficulty, setMaxDifficulty] = useState('');
  const [intent, setIntent] = useState<'all' | OpportunityIntent>('all');
  const [sort, setSort] = useState<OpportunitySort>('score');
  const [dir, setDir] = useState<OpportunitySortDir>('desc');

  const params = new URLSearchParams();
  const minVolumeNum = minVolume.trim() === '' ? null : Number(minVolume);
  if (minVolumeNum != null && Number.isFinite(minVolumeNum) && minVolumeNum >= 0) {
    params.set('minVolume', String(minVolumeNum));
  }
  const maxDifficultyNum = maxDifficulty.trim() === '' ? null : Number(maxDifficulty);
  if (maxDifficultyNum != null && Number.isFinite(maxDifficultyNum) && maxDifficultyNum >= 0) {
    params.set('maxDifficulty', String(maxDifficultyNum));
  }
  if (intent !== 'all') params.set('intent', intent);
  params.set('sort', sort);
  params.set('dir', dir);
  const queryString = params.toString();

  const { data, error, loading } = useAsync<OpportunitiesDto>(
    () => api(`/projects/${projectId}/keyword/opportunities?${queryString}`),
    [projectId, queryString],
  );

  const snapshot = data?.snapshot ?? null;
  const opportunities = data?.opportunities ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Opportunities</CardTitle>
        <CardDescription>
          Explainable keyword opportunities derived from your latest competitor gap analysis. Read-only - this makes
          no provider calls.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loading && <div className="py-8 text-center text-sm text-muted-foreground">Analyzing opportunities…</div>}

        {!loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Could not load opportunities. Please try again.
          </div>
        )}

        {!loading && !error && !snapshot && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No competitor gap data available yet. Run a competitor gap analysis first.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {!loading && !error && snapshot && (
          <>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Gap snapshot from {fmtDate(snapshot.fetchedAt)} ·{' '}
              <span className="font-medium text-foreground">
                {SNAPSHOT_FRESHNESS_LABELS[snapshot.freshness.state]}
              </span>
              {snapshot.freshness.state === 'stale' && <span className="text-destructive"> · may be outdated</span>}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-xs text-muted-foreground">
                Min. volume
                <Input
                  aria-label="Minimum volume"
                  inputMode="numeric"
                  className="h-8 w-28"
                  value={minVolume}
                  onChange={(e) => setMinVolume(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Max. difficulty
                <Input
                  aria-label="Maximum difficulty"
                  inputMode="numeric"
                  className="h-8 w-28"
                  value={maxDifficulty}
                  onChange={(e) => setMaxDifficulty(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Intent
                <select
                  aria-label="Intent"
                  className={SELECT_CLASS}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value as 'all' | OpportunityIntent)}
                >
                  <option value="all">Any</option>
                  {OPPORTUNITY_INTENTS.map((i) => (
                    <option key={i} value={i}>
                      {OPPORTUNITY_INTENT_LABELS[i]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Sort
                <select
                  aria-label="Sort"
                  className={SELECT_CLASS}
                  value={sort}
                  onChange={(e) => setSort(e.target.value as OpportunitySort)}
                >
                  {OPPORTUNITY_SORTS.map((s) => (
                    <option key={s} value={s}>
                      {OPPORTUNITY_SORT_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Direction
                <select
                  aria-label="Direction"
                  className={SELECT_CLASS}
                  value={dir}
                  onChange={(e) => setDir(e.target.value as OpportunitySortDir)}
                >
                  {OPPORTUNITY_SORT_DIRS.map((d) => (
                    <option key={d} value={d}>
                      {OPPORTUNITY_SORT_DIR_LABELS[d]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {opportunities.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No opportunities match these filters.
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Showing {fmtNum(data!.count)} of {fmtNum(data!.total)} opportunities.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Volume</TableHead>
                      <TableHead className="text-right">Difficulty</TableHead>
                      <TableHead className="text-right">CPC</TableHead>
                      <TableHead className="text-right">Competitors</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead>Why</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {opportunities.map((o) => (
                      <TableRow key={o.keyword}>
                        <TableCell className="max-w-[22rem] truncate font-medium" title={o.variants.join(', ')}>
                          {o.keyword}
                          {o.intent && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {OPPORTUNITY_INTENT_LABELS[o.intent]}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(o.searchVolume, 'int')}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(o.difficulty, 'int')}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(o.cpc, 'money')}</TableCell>
                        <TableCell
                          className="text-right tabular-nums"
                          title={o.competitors
                            .map((c) => (c.rank != null ? `${c.domain} #${num(c.rank)}` : c.domain))
                            .join(', ')}
                        >
                          {fmtNum(o.competitorCount)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{fmtNum(o.score)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {o.reasons.length === 0
                            ? '—'
                            : o.reasons.map((r) => OPPORTUNITY_REASON_LABELS[r]).join(' · ')}
                        </TableCell>
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
  );
}

type KeywordsTab = 'mine' | 'research' | 'expansion' | 'competitors' | 'opportunities';

const KEYWORDS_TABS: Array<{ id: KeywordsTab; label: string }> = [
  { id: 'mine', label: 'My keywords' },
  { id: 'research', label: 'Research' },
  { id: 'expansion', label: 'Expand' },
  { id: 'competitors', label: 'Competitors' },
  { id: 'opportunities', label: 'Opportunities' },
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
      {tab === 'expansion' && <KeywordExpansion projectId={projectId} role={role} />}
      {tab === 'competitors' && <CompetitorResearch projectId={projectId} role={role} />}
      {tab === 'opportunities' && (
        <Opportunities projectId={projectId} onGoToCompetitors={() => setTab('competitors')} />
      )}

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

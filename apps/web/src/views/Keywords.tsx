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
import { useEffect, useRef, useState } from 'react';
import { useAsync, useJobs, num, fmtNum, fmtDate } from '../lib/ui';
import { api, ApiRequestError } from '../lib/api';
import {
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  KEYWORD_EXPANSION_MAX_SEEDS,
  KEYWORD_EXPANSION_METHODS,
  OPPORTUNITIES_MAX_LIMIT,
  OPPORTUNITY_INTENTS,
  OPPORTUNITY_SORTS,
  OPPORTUNITY_SORT_DIRS,
  TOPIC_ARTICLE_MAX_COMPETITORS,
} from '@seo/contracts';
import type {
  CompetitorDiscoveryStartDto,
  CompetitorGapStartDto,
  CompetitorResearchRunDto,
  CoreTopicDto,
  CoreTopicsDto,
  KeywordDto,
  KeywordExpansionMethod,
  KeywordExpansionRunDto,
  KeywordExpansionSaveDto,
  KeywordExpansionStartDto,
  KeywordOpportunityDto,
  KeywordQuery,
  KeywordResearchRunDto,
  KeywordResearchStartDto,
  KnowledgeReadinessState,
  OpportunitiesDto,
  OpportunityIntent,
  OpportunityReason,
  OpportunitySort,
  OpportunitySortDir,
  ProjectKeywordsDto,
  SourceSnapshotDto,
  SourceSnapshotFreshnessState,
  TopicRecommendationDto,
  TopicRecommendationsDto,
  TopicRelevanceState,
} from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

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

/**
 * Live Search Console sync state. Progress is the job row's own value - the
 * worker reports real phase percentages - so the bar is indeterminate only
 * before the first report, never a fabricated number.
 */
function SyncProgress({ job }: { job: { status?: string; progress?: number; message?: string | null } }) {
  const pct = typeof job.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : null;
  const indeterminate = job.status === 'queued' || pct === null;
  const label = job.message || (job.status === 'queued' ? 'Search Console sync queued…' : 'Synchronizing Google Search Console…');
  return (
    <div className="grid gap-2 py-1" role="status" aria-label="Search Console sync">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        {!indeterminate && <span className="tabular-nums text-muted-foreground">{pct}%</span>}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            indeterminate
              ? 'h-full w-1/3 animate-pulse rounded-full bg-primary'
              : 'h-full rounded-full bg-primary transition-all'
          }
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
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
interface CompetitorResearchProps {
  projectId: string;
  role: string;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
}

function CompetitorResearch({ projectId, role, selected, onSelectedChange }: CompetitorResearchProps) {
  const [discovery, setDiscovery] = useState<CompetitorResearchRunDto | null>(null);
  const [discoverySnapshot, setDiscoverySnapshot] = useState<SourceSnapshotDto | null>(null);
  const [gapRun, setGapRun] = useState<CompetitorResearchRunDto | null>(null);
  const [gapSnapshot, setGapSnapshot] = useState<SourceSnapshotDto | null>(null);
  const [gapSnapshotFor, setGapSnapshotFor] = useState<string[]>([]);
  const [editingSelection, setEditingSelection] = useState(false);
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
    if (selected.length > 0) void loadGapSnapshot(selected);
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
      onSelectedChange([]);
      setEditingSelection(false);
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
    if (selected.includes(domain)) {
      onSelectedChange(selected.filter((d) => d !== domain));
    } else if (selected.length < COMPETITOR_RESEARCH_MAX_COMPETITORS) {
      onSelectedChange([...selected, domain]);
    }
    setEditingSelection(true);
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

        {selected.length > 0 && !editingSelection && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Analyzing:</span>
              {selected.map((d) => (
                <span key={d} className="rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
                  {d}
                </span>
              ))}
            </span>
            <Button variant="outline" size="sm" disabled={gapInFlight} onClick={() => setEditingSelection(true)}>
              Change competitors
            </Button>
          </div>
        )}

        {candidates.length > 0 && (selected.length === 0 || editingSelection) && (
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
            <div className="flex flex-wrap gap-2">
              <Button disabled={!allowed || gapInFlight || selected.length === 0} onClick={() => void analyze(false)}>
                {gapInFlight ? 'Analyzing…' : 'Analyze keyword gaps'}
              </Button>
              {editingSelection && selected.length > 0 && (
                <Button variant="outline" disabled={gapInFlight} onClick={() => setEditingSelection(false)}>
                  Done
                </Button>
              )}
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

const OPPORTUNITY_REVEAL_STEP = 25;

/**
 * KW5: a deterministic, explainable read over the project's current-best-known
 * competitor gap snapshot for the EXACT active competitor set. It never starts
 * provider work - when no matching gap snapshot exists it points the user at the
 * Competitors tab instead. Every row shows why it scored the way it did; a
 * missing metric renders as a dash, never a zero.
 */
function Opportunities({
  projectId,
  role,
  selected,
  onGoToCompetitors,
}: {
  projectId: string;
  role: string;
  selected: string[];
  onGoToCompetitors: () => void;
}) {
  const [minVolume, setMinVolume] = useState('');
  const [maxDifficulty, setMaxDifficulty] = useState('');
  const [intent, setIntent] = useState<'all' | OpportunityIntent>('all');
  const [sort, setSort] = useState<OpportunitySort>('score');
  const [dir, setDir] = useState<OpportunitySortDir>('desc');
  const [visible, setVisible] = useState(OPPORTUNITY_REVEAL_STEP);
  const [creating, setCreating] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canCreate = canStartResearch(role);

  const competitorsParam = selected.join(',');
  const params = new URLSearchParams();
  if (selected.length > 0) {
    params.set('competitors', competitorsParam);
    params.set('limit', String(OPPORTUNITIES_MAX_LIMIT));
  }
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

  const { data, error, loading } = useAsync<OpportunitiesDto | null>(
    () =>
      selected.length === 0
        ? Promise.resolve(null)
        : api(`/projects/${projectId}/keyword/opportunities?${queryString}`),
    [projectId, queryString],
  );

  const snapshot = data?.snapshot ?? null;
  const opportunities = data?.opportunities ?? [];

  useEffect(() => {
    setVisible(OPPORTUNITY_REVEAL_STEP);
  }, [queryString]);

  const shown = opportunities.slice(0, visible);

  const createArticle = async (o: KeywordOpportunityDto) => {
    setNotice(null);
    setActionError(null);
    setCreating(o.keyword);
    try {
      await api(`/projects/${projectId}/keyword/opportunities/topics/article`, {
        method: 'POST',
        body: {
          topic_name: o.keyword,
          topic_description: '',
          primary_keyword: o.keyword,
          keywords: [{ keyword: o.keyword, volume: o.searchVolume }],
          competitors: o.competitors
            .slice(0, TOPIC_ARTICLE_MAX_COMPETITORS)
            .map((c) => ({ domain: c.domain, rank: c.rank })),
          opportunity_score: o.score,
          reasons: o.reasons,
          difficulty: o.difficulty,
          intent: o.intent,
        },
      });
      setNotice(`Draft generation started for "${o.keyword}". Follow it in Content.`);
    } catch (e) {
      setActionError(
        e instanceof ApiRequestError && e.code === 'forbidden'
          ? 'You do not have permission to create articles.'
          : 'Could not start the draft. Please try again.',
      );
    } finally {
      setCreating(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Opportunities</CardTitle>
        <CardDescription>
          Explainable keyword opportunities derived from your selected competitors' gap analysis. Read-only - this
          makes no provider calls.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">{notice}</div>
        )}
        {actionError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        )}

        {loading && <div className="py-8 text-center text-sm text-muted-foreground">Analyzing opportunities…</div>}

        {!loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Could not load opportunities. Please try again.
          </div>
        )}

        {!loading && !error && selected.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Select competitors to see their opportunities.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {!loading && !error && selected.length > 0 && !snapshot && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No competitor gap data available yet for this competitor set. Run a competitor gap analysis first.{' '}
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
                  Showing {fmtNum(shown.length)} of {fmtNum(data!.total)} opportunities.
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
                      <TableHead>Draft</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((o) => (
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
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canCreate || creating === o.keyword}
                            title={canCreate ? undefined : 'Editors and above can create drafts.'}
                            onClick={() => void createArticle(o)}
                          >
                            {creating === o.keyword ? 'Starting…' : 'Create article'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!canCreate && (
                  <p className="text-xs text-muted-foreground">Editors and above can create drafts.</p>
                )}
                {shown.length < opportunities.length && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVisible((v) => v + OPPORTUNITY_REVEAL_STEP)}
                    >
                      Show more
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * KW5.1: the Compare projection of the SAME gap evidence as Opportunities - no
 * new endpoint, no new scoring. It reuses the exact-set opportunities read and
 * lays each opportunity's competitor ranks out as a matrix. A missing cell
 * renders as an em dash: "no page-one gap evidence for this keyword/competitor
 * in this bounded analysis", never rank 0.
 */
function CompetitorCompare({
  projectId,
  selected,
  onGoToCompetitors,
}: {
  projectId: string;
  selected: string[];
  onGoToCompetitors: () => void;
}) {
  const competitorsParam = selected.join(',');
  const params = new URLSearchParams();
  if (selected.length > 0) {
    params.set('competitors', competitorsParam);
    params.set('limit', String(OPPORTUNITIES_MAX_LIMIT));
    params.set('sort', 'score');
    params.set('dir', 'desc');
  }
  const queryString = params.toString();

  const { data, error, loading } = useAsync<OpportunitiesDto | null>(
    () =>
      selected.length === 0
        ? Promise.resolve(null)
        : api(`/projects/${projectId}/keyword/opportunities?${queryString}`),
    [projectId, competitorsParam],
  );

  const columns =
    data?.snapshot && data.snapshot.competitors.length > 0 ? data.snapshot.competitors : selected;
  const opportunities = data?.opportunities ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare</CardTitle>
        <CardDescription>
          The same gap evidence as Opportunities, laid out per competitor. Read-only - this makes no provider calls.
          A dash means no page-one gap was observed for that keyword and competitor.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {selected.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Select competitors to compare.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {selected.length > 0 && loading && (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading comparison…</div>
        )}

        {selected.length > 0 && !loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Could not load the comparison. Please try again.
          </div>
        )}

        {selected.length > 0 && !loading && !error && data && !data.snapshot && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No gap snapshot for this competitor set yet. Run a competitor gap analysis first.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {selected.length > 0 && !loading && !error && data?.snapshot && (
          <>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Gap snapshot from {fmtDate(data.snapshot.fetchedAt)} ·{' '}
              <span className="font-medium text-foreground">
                {SNAPSHOT_FRESHNESS_LABELS[data.snapshot.freshness.state]}
              </span>
              {data.snapshot.freshness.state === 'stale' && <span className="text-destructive"> · may be outdated</span>}
            </div>

            {opportunities.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No page-one keyword gaps were found for this competitor set.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Volume</TableHead>
                      <TableHead className="text-right">Difficulty</TableHead>
                      {columns.map((domain) => (
                        <TableHead key={domain} className="text-right">
                          {domain}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {opportunities.map((o) => (
                      <TableRow key={o.keyword}>
                        <TableCell className="max-w-[24rem] truncate font-medium" title={o.variants.join(', ')}>
                          {o.keyword}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(o.searchVolume, 'int')}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMetric(o.difficulty, 'int')}</TableCell>
                        {columns.map((domain) => {
                          const match = o.competitors.find((c) => c.domain === domain);
                          return (
                            <TableCell key={domain} className="text-right tabular-nums">
                              {match?.rank == null ? '—' : fmtNum(match.rank)}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const TOPIC_RELEVANCE_LABELS: Record<TopicRelevanceState, string> = {
  strong: 'Strong match',
  moderate: 'Moderate match',
  weak: 'Weak match',
  no_match: 'No clear match',
};

const KNOWLEDGE_READINESS_LABELS: Record<KnowledgeReadinessState, string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
  none: 'None',
};

/**
 * KW6 core-topics editor. Core topics live in the project's settings (no new
 * table); this is the only place they are managed. Saving replaces the list and
 * immediately refreshes the recommendations above it.
 */
function CoreTopicsEditor({
  projectId,
  role,
  onSaved,
  onClose,
}: {
  projectId: string;
  role: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { data, loading, error } = useAsync<CoreTopicsDto>(
    () => api(`/projects/${projectId}/keyword/core-topics`),
    [projectId],
  );
  const [rows, setRows] = useState<Array<{ name: string; description: string }>>([]);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const allowed = canStartResearch(role);

  useEffect(() => {
    if (data && !seeded) {
      setRows(data.topics.map((t) => ({ name: t.name, description: t.description })));
      setSeeded(true);
    }
  }, [data, seeded]);

  const update = (index: number, patch: Partial<{ name: string; description: string }>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const save = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const topics: CoreTopicDto[] = rows
        .map((row) => ({ name: row.name.trim(), description: row.description.trim() }))
        .filter((row) => row.name.length > 0);
      await api(`/projects/${projectId}/keyword/core-topics`, { method: 'PUT', body: { topics } });
      onSaved();
      onClose();
    } catch (e) {
      setSaveError(
        e instanceof ApiRequestError && e.code === 'forbidden'
          ? 'You do not have permission to edit core topics.'
          : 'Could not save core topics. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">
        Core topics describe what this project is about. Keyword opportunities are matched against them to suggest
        topics worth writing or researching. Description carries the context a bare name lacks.
      </p>

      {loading && <div className="py-4 text-center text-sm text-muted-foreground">Loading core topics…</div>}
      {!loading && error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not load core topics. Please try again.
        </div>
      )}

      {!loading && !error && (
        <>
          {!allowed && (
            <p className="text-sm text-muted-foreground">Only editors and above can change core topics.</p>
          )}
          {rows.length === 0 && <p className="text-sm text-muted-foreground">No core topics yet.</p>}
          {rows.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start">
              <Input
                aria-label={`Topic ${index + 1} name`}
                placeholder="Topic name"
                className="h-8"
                value={row.name}
                disabled={!allowed}
                onChange={(e) => update(index, { name: e.target.value })}
              />
              <Textarea
                aria-label={`Topic ${index + 1} description`}
                placeholder="What this topic covers"
                className="min-h-[38px]"
                value={row.description}
                disabled={!allowed}
                onChange={(e) => update(index, { description: e.target.value })}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed}
                onClick={() => setRows((current) => current.filter((_r, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}

          {saveError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {saveError}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!allowed}
              onClick={() => setRows((current) => [...current, { name: '', description: '' }])}
            >
              Add topic
            </Button>
            <Button size="sm" disabled={!allowed || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save topics'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * KW6: turn the KW5.1 competitor-gap opportunities into a few actionable topic
 * recommendations. It reuses the same exact-set opportunity read, then scores
 * each project core topic for relevance and knowledge readiness and recommends
 * either writing or researching. It is a pure read - no provider call happens
 * until the user explicitly starts a draft - and relevance is shown only as a
 * coarse state, never as a fabricated percentage.
 */
function Topics({
  projectId,
  role,
  selected,
  onGoToCompetitors,
}: {
  projectId: string;
  role: string;
  selected: string[];
  onGoToCompetitors: () => void;
}) {
  const [managingTopics, setManagingTopics] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const competitorsParam = selected.join(',');
  const { data, error, loading } = useAsync<TopicRecommendationsDto | null>(
    () =>
      selected.length === 0
        ? Promise.resolve(null)
        : api(
            `/projects/${projectId}/keyword/opportunities/topics?competitors=${encodeURIComponent(competitorsParam)}`,
          ),
    [projectId, competitorsParam, reloadKey],
  );

  const recommendations = data?.recommendations ?? [];

  const createArticle = async (rec: TopicRecommendationDto) => {
    setNotice(null);
    setActionError(null);
    setCreating(rec.topic.name);
    try {
      await api(`/projects/${projectId}/keyword/opportunities/topics/article`, {
        method: 'POST',
        body: {
          topic_name: rec.topic.name,
          topic_description: rec.topic.description,
          primary_keyword: rec.keywords[0]?.keyword ?? null,
          keywords: rec.keywords.map((k) => ({ keyword: k.keyword, volume: k.volume })),
          competitors: rec.competitorEvidence.map((c) => ({ domain: c.domain, rank: c.rank })),
          opportunity_score: rec.bestOpportunityScore,
        },
      });
      setNotice(`Draft generation started for "${rec.topic.name}". Follow it in Content.`);
    } catch (e) {
      setActionError(
        e instanceof ApiRequestError && e.code === 'forbidden'
          ? 'You do not have permission to create articles.'
          : 'Could not start the draft. Please try again.',
      );
    } finally {
      setCreating(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Topics</CardTitle>
        <CardDescription>
          A few actionable topics built from your competitor gap, matched against your core topics and your knowledge
          base. Read-only - a draft is only created when you ask for one.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setManagingTopics((v) => !v)}>
            {managingTopics ? 'Hide core topics' : 'Manage core topics'}
          </Button>
        </div>

        {managingTopics && (
          <CoreTopicsEditor
            projectId={projectId}
            role={role}
            onSaved={() => setReloadKey((k) => k + 1)}
            onClose={() => setManagingTopics(false)}
          />
        )}

        {notice && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">{notice}</div>
        )}
        {actionError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        )}

        {selected.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Select competitors to see topic recommendations.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {selected.length > 0 && loading && (
          <div className="py-8 text-center text-sm text-muted-foreground">Building topic recommendations…</div>
        )}

        {selected.length > 0 && !loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Could not load topic recommendations. Please try again.
          </div>
        )}

        {selected.length > 0 && !loading && !error && data && !data.topicsConfigured && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No core topics are configured for this project yet. Add a few to get topic recommendations.{' '}
            <button type="button" className="underline" onClick={() => setManagingTopics(true)}>
              Add core topics
            </button>
          </div>
        )}

        {selected.length > 0 && !loading && !error && data && data.topicsConfigured && !data.snapshot && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No competitor gap data available yet for this competitor set. Run a competitor gap analysis first.{' '}
            <button type="button" className="underline" onClick={onGoToCompetitors}>
              Go to Competitors
            </button>
          </div>
        )}

        {selected.length > 0 && !loading && !error && data && data.topicsConfigured && data.snapshot && (
          <>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Based on {fmtNum(data.consideredCount)} gap keyword{data.consideredCount === 1 ? '' : 's'} across{' '}
              {fmtNum(data.candidateCount)} topic candidate{data.candidateCount === 1 ? '' : 's'} from the gap snapshot
              of {fmtDate(data.snapshot.fetchedAt)}.
            </div>

            {!data.knowledgeConfigured && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Knowledge retrieval is not configured, so knowledge readiness is reported as none.
              </div>
            )}

            {recommendations.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No topics are actionable from this gap yet. The gap keywords do not clearly match your core topics, or
                the opportunities are too thin.
              </div>
            ) : (
              recommendations.map((rec) => {
                const canCreate = canStartResearch(role);
                return (
                  <div key={rec.topic.name} className="grid gap-3 rounded-md border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium">{rec.topic.name}</h3>
                        {rec.topic.description && (
                          <p className="text-sm text-muted-foreground">{rec.topic.description}</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full border px-2 py-0.5">
                          {TOPIC_RELEVANCE_LABELS[rec.relevance.state]}
                        </span>
                        <span className="rounded-full border px-2 py-0.5">
                          Knowledge: {KNOWLEDGE_READINESS_LABELS[rec.knowledge.state]}
                        </span>
                      </div>
                    </div>

                    <p className="text-sm text-muted-foreground">{rec.why}</p>

                    <div className="grid gap-1 text-sm">
                      <p className="text-xs font-medium text-muted-foreground">
                        Matching keywords ({fmtNum(rec.candidateCount)})
                      </p>
                      <p>
                        {rec.keywords
                          .map((k) => `${k.keyword}${k.volume != null ? ` (${fmtNum(k.volume)}/mo)` : ''}`)
                          .join(' · ')}
                        {rec.candidateCount > rec.keywords.length && ` +${rec.candidateCount - rec.keywords.length} more`}
                      </p>
                    </div>

                    {rec.competitorEvidence.length > 0 && (
                      <div className="grid gap-1 text-sm">
                        <p className="text-xs font-medium text-muted-foreground">Competitor evidence</p>
                        <p>
                          {rec.competitorEvidence
                            .map((c) => `${c.domain}${c.rank != null ? ` #${num(c.rank)}` : ''}`)
                            .join(' · ')}
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      {rec.recommendation === 'create_article' ? (
                        <Button
                          size="sm"
                          disabled={!canCreate || creating === rec.topic.name}
                          onClick={() => void createArticle(rec)}
                        >
                          {creating === rec.topic.name ? 'Starting…' : 'Create article'}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled title="Pre-write research is not available yet">
                          Research recommended
                        </Button>
                      )}
                      {!canCreate && <span className="text-xs text-muted-foreground">Editors and above can create drafts.</span>}
                      {rec.recommendation === 'research' && (
                        <span className="text-xs text-muted-foreground">
                          Research is advisory only - no research run is started from here yet.
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}


type KeywordsTab = 'mine' | 'research' | 'expansion' | 'competitors' | 'compare' | 'opportunities' | 'topics';

const KEYWORDS_TABS: Array<{ id: KeywordsTab; label: string }> = [
  { id: 'mine', label: 'My keywords' },
  { id: 'research', label: 'Research' },
  { id: 'expansion', label: 'Expand' },
  { id: 'competitors', label: 'Competitors' },
  { id: 'compare', label: 'Compare' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'topics', label: 'Topics' },
];

export function Keywords({ projectId, role }: { projectId: string; role: string }) {
  const [tab, setTab] = useState<KeywordsTab>('mine');
  const [selectedCompetitors, setSelectedCompetitors] = useState<string[]>([]);
  const { data, error, loading, reload: reloadKeywords } = useAsync<ProjectKeywordsDto>(
    () => api(`/projects/${projectId}/gsc/keywords`),
    [projectId],
  );
  const canSync = canStartResearch(role);
  const { jobs, reload: reloadJobs } = useJobs(projectId, true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const gscJobs = jobs.filter((j) => j.job_type === 'gsc_sync');
  const activeSync = gscJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null;
  const lastSync = gscJobs[0] ?? null;
  const lastSyncError =
    !activeSync && lastSync && (lastSync.status === 'failed' || lastSync.status === 'canceled')
      ? (lastSync.error?.message ??
        (lastSync.status === 'canceled'
          ? 'The last Search Console sync was canceled.'
          : 'Search Console sync failed. Please try again.'))
      : null;

  const startSync = async () => {
    setSyncError(null);
    setSyncing(true);
    try {
      await api(`/projects/${projectId}/gsc/sync`, { method: 'POST' });
      reloadJobs();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  // Refresh the keyword read when a sync leaves the queued/running state, so new
  // data appears without a manual reload. The first observation of an already
  // running job must not refetch (the mount load already did).
  const previousActiveSyncId = useRef<string | null>(null);
  useEffect(() => {
    const activeId = activeSync?.id ?? null;
    if (previousActiveSyncId.current && !activeId) {
      reloadKeywords();
      reloadJobs();
    }
    previousActiveSyncId.current = activeId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSync?.id]);

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
      {tab === 'competitors' && (
        <CompetitorResearch
          projectId={projectId}
          role={role}
          selected={selectedCompetitors}
          onSelectedChange={setSelectedCompetitors}
        />
      )}
      {tab === 'compare' && (
        <CompetitorCompare
          projectId={projectId}
          selected={selectedCompetitors}
          onGoToCompetitors={() => setTab('competitors')}
        />
      )}
      {tab === 'opportunities' && (
        <Opportunities
          projectId={projectId}
          role={role}
          selected={selectedCompetitors}
          onGoToCompetitors={() => setTab('competitors')}
        />
      )}
      {tab === 'topics' && (
        <Topics
          projectId={projectId}
          role={role}
          selected={selectedCompetitors}
          onGoToCompetitors={() => setTab('competitors')}
        />
      )}

      {tab === 'mine' && (
        <Card>
          <CardHeader>
            <CardTitle>My keywords</CardTitle>
            <CardDescription>
              Queries your site is seen for in Google Search Console, and how they perform over the last 28 days.
            </CardDescription>
            {canSync && data?.propertyId && data.keywords.length > 0 && !activeSync && (
              <CardAction>
                <Button size="sm" variant="outline" disabled={syncing} onClick={() => void startSync()}>
                  {syncing ? 'Starting…' : 'Sync again'}
                </Button>
              </CardAction>
            )}
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
                {activeSync && <SyncProgress job={activeSync} />}

                {!activeSync && (syncError ?? lastSyncError) && (
                  <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {syncError ?? lastSyncError}
                  </div>
                )}

                {!data.propertyId && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    Google Search Console is not connected to this project.
                  </div>
                )}

                {data.propertyId && data.keywords.length === 0 && !activeSync && (
                  <div className="grid gap-3 py-8 text-center text-sm text-muted-foreground">
                    <p>No keyword data is available yet. Run a Google Search Console sync first.</p>
                    {canSync && (
                      <div>
                        <Button disabled={syncing} onClick={() => void startSync()}>
                          {syncing ? 'Starting…' : 'Sync Google Search Console'}
                        </Button>
                      </div>
                    )}
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

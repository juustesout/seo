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
import type {
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

export function Keywords({ projectId, role }: { projectId: string; role: string }) {
  const { data, error, loading } = useAsync<ProjectKeywordsDto>(
    () => api(`/projects/${projectId}/gsc/keywords`),
    [projectId],
  );

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Keywords"
        description="Research new keyword opportunities, and see the queries your site is already seen for in Google Search Console."
      />

      <KeywordResearch projectId={projectId} role={role} />

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
    </div>
  );
}

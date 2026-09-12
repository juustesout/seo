/**
 * Knowledge discovery (KB9) - bounded, human-approved link discovery.
 *
 * Start a session from a seed URL, poll it while the worker fetches the seed
 * page, then review the bounded proposal. Nothing is created or indexed until
 * the editor selects candidates and applies them, which creates normal URL
 * sources and queues the existing ingestion. Candidates are untrusted text
 * rendered as plain text; raw provider payloads and internal errors never reach
 * the browser.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  KNOWLEDGE_DISCOVERY_DEFAULT_MAX_DEPTH,
  KNOWLEDGE_DISCOVERY_DEFAULT_MAX_URLS,
  KNOWLEDGE_DISCOVERY_MAX_DEPTH,
  KNOWLEDGE_DISCOVERY_MAX_URLS,
  KNOWLEDGE_DISCOVERY_SEED_MAX_CHARS,
  knowledgeErrorMessage,
  type KnowledgeCollectionDto,
  type KnowledgeDiscoveryApplyResultDto,
  type KnowledgeDiscoveryCandidate,
  type KnowledgeDiscoveryScope,
  type KnowledgeDiscoverySessionDetailDto,
  type KnowledgeDiscoveryStatus,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm text-foreground';

const TERMINAL: KnowledgeDiscoveryStatus[] = ['ready', 'failed', 'applied'];

const REASON_LABELS: Record<string, string> = {
  url_not_allowed: 'URL not allowed',
  out_of_scope: 'Out of scope',
  duplicate: 'Already in the Knowledge Base',
};

const STATUS_LABELS: Record<KnowledgeDiscoveryStatus, string> = {
  queued: 'Discovering links…',
  processing: 'Discovering links…',
  ready: 'Proposal ready',
  failed: 'Discovery failed',
  applied: 'Applied',
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function candidateLabel(c: KnowledgeDiscoveryCandidate): string {
  return c.title?.trim() || c.url;
}

export function KnowledgeDiscoveryPanel({
  projectId,
  collections = [],
  canEdit,
  onApplied,
}: {
  projectId: string;
  collections?: KnowledgeCollectionDto[];
  canEdit: boolean;
  onApplied?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [seedUrl, setSeedUrl] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [scope, setScope] = useState<KnowledgeDiscoveryScope>('same_host');
  const [maxUrls, setMaxUrls] = useState(String(KNOWLEDGE_DISCOVERY_DEFAULT_MAX_URLS));
  const [maxDepth, setMaxDepth] = useState(String(KNOWLEDGE_DISCOVERY_DEFAULT_MAX_DEPTH));

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<KnowledgeDiscoverySessionDetailDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeDiscoveryApplyResultDto | null>(null);

  const loadSession = useCallback(
    async (id: string) => {
      const next = await api<KnowledgeDiscoverySessionDetailDto>(
        `/projects/${projectId}/knowledge/discovery/${id}`,
      );
      setSession(next);
      return next;
    },
    [projectId],
  );

  const status = session?.status;
  useEffect(() => {
    if (!sessionId || !status || TERMINAL.includes(status)) return;
    const id = window.setInterval(() => {
      void loadSession(sessionId).catch((e) => setError(message(e)));
    }, 3000);
    return () => window.clearInterval(id);
  }, [sessionId, status, loadSession]);

  const reset = useCallback(() => {
    setSessionId(null);
    setSession(null);
    setSelected([]);
    setResult(null);
    setError(null);
  }, []);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEdit || !seedUrl.trim() || starting) return;
    setStarting(true);
    setError(null);
    setResult(null);
    setSelected([]);
    try {
      const res = await api<{ session: KnowledgeDiscoverySessionDetailDto; job: { id: string } }>(
        `/projects/${projectId}/knowledge/discovery`,
        {
          method: 'POST',
          body: {
            seedUrl: seedUrl.trim(),
            collectionId: collectionId || null,
            maxUrls: Number(maxUrls),
            maxDepth: Number(maxDepth),
            scope,
          },
        },
      );
      setSessionId(res.session.id);
      setSession(res.session);
      await loadSession(res.session.id).catch(() => undefined);
    } catch (e2) {
      setError(message(e2));
    } finally {
      setStarting(false);
    }
  };

  const toggle = (candidate: KnowledgeDiscoveryCandidate) => {
    if (!candidate.eligible) return;
    setSelected((ids) =>
      ids.includes(candidate.normalizedUrl)
        ? ids.filter((x) => x !== candidate.normalizedUrl)
        : [...ids, candidate.normalizedUrl],
    );
  };

  const selectEligible = () => {
    setSelected((session?.candidates ?? []).filter((c) => c.eligible).map((c) => c.normalizedUrl));
  };

  const apply = async () => {
    if (!canEdit || !sessionId || selected.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<KnowledgeDiscoveryApplyResultDto>(
        `/projects/${projectId}/knowledge/discovery/${sessionId}/apply`,
        { method: 'POST', body: { urls: selected } },
      );
      setResult(res);
      setSelected([]);
      setSession((s) => (s ? { ...s, status: 'applied' } : s));
      onApplied?.();
      await loadSession(sessionId).catch(() => undefined);
    } catch (e2) {
      setError(message(e2));
    } finally {
      setApplying(false);
    }
  };

  const candidates = session?.candidates ?? [];
  const eligibleCount = candidates.filter((c) => c.eligible).length;
  const ready = status === 'ready' || status === 'applied';
  const failed = status === 'failed';

  return (
    <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Discover from website</div>
          <div className="text-xs text-muted-foreground">
            Propose in-scope links from a page; you choose what becomes a source.
          </div>
        </div>
        {canEdit && (
          <Button
            type="button"
            size="sm"
            variant={open ? 'outline' : 'default'}
            onClick={() => {
              setOpen((v) => !v);
              if (open) reset();
            }}
          >
            {open ? 'Close discovery' : 'Discover from website'}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {open && (
        <>
          <form className="grid gap-2 sm:grid-cols-2" onSubmit={start}>
            <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
              Seed URL
              <Input
                type="url"
                placeholder="https://example.com/blog"
                value={seedUrl}
                maxLength={KNOWLEDGE_DISCOVERY_SEED_MAX_CHARS}
                onChange={(e) => setSeedUrl(e.target.value)}
                required
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Collection
              <select
                aria-label="Collection"
                className={selectClass}
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value)}
              >
                <option value="">No collection</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Scope
              <select
                aria-label="Scope"
                className={selectClass}
                value={scope}
                onChange={(e) => setScope(e.target.value as KnowledgeDiscoveryScope)}
              >
                <option value="same_host">Same host</option>
                <option value="same_domain">Same domain</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Max URLs
              <Input
                type="number"
                min={1}
                max={KNOWLEDGE_DISCOVERY_MAX_URLS}
                value={maxUrls}
                onChange={(e) => setMaxUrls(e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Max depth
              <Input
                type="number"
                min={0}
                max={KNOWLEDGE_DISCOVERY_MAX_DEPTH}
                value={maxDepth}
                onChange={(e) => setMaxDepth(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button type="submit" size="sm" disabled={starting || !seedUrl.trim()}>
                {starting ? 'Starting…' : 'Discover links'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Bounded discovery only; nothing is fetched or indexed until you apply a selection.
              </span>
            </div>
          </form>

          {session && (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={failed ? 'destructive' : 'outline'}>{STATUS_LABELS[session.status]}</Badge>
                <span className="text-muted-foreground">
                  {failed
                    ? knowledgeErrorMessage(session.errorCode)
                    : `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} · ${eligibleCount} eligible`}
                </span>
              </div>

              {ready && candidates.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={selectEligible} disabled={eligibleCount === 0}>
                      Select eligible
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setSelected([])} disabled={selected.length === 0}>
                      Deselect all
                    </Button>
                    <span className="text-xs text-muted-foreground">{selected.length} selected</span>
                  </div>

                  <ul className="m-0 grid list-none gap-1.5 p-0">
                    {candidates.map((c) => (
                      <li
                        key={c.normalizedUrl}
                        className="flex flex-wrap items-start gap-2 rounded-md border bg-background px-2.5 py-2"
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${candidateLabel(c)}`}
                          checked={selected.includes(c.normalizedUrl)}
                          disabled={!c.eligible}
                          onChange={() => toggle(c)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium">{candidateLabel(c)}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground">{c.url}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            <span>Depth {c.depth}</span>
                            {!c.eligible && c.reason && <span className="text-warning">{REASON_LABELS[c.reason] ?? c.reason}</span>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" onClick={() => void apply()} disabled={applying || selected.length === 0}>
                      {applying ? 'Adding…' : 'Add selected to Knowledge Base'}
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      This creates URL sources and queues ingestion; indexing happens in the worker.
                    </span>
                  </div>
                </>
              )}

              {ready && candidates.length === 0 && (
                <p className="text-sm text-muted-foreground">No in-scope links were found from this page.</p>
              )}

              {result && (
                <div className="rounded-md border bg-background px-3 py-2 text-sm">
                  {result.created} added, {result.alreadyExists} already existed, {result.rejected} rejected
                  {result.queued !== result.created ? ` (${result.queued} queued for indexing)` : ''}.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

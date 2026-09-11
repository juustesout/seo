/**
 * Publishing view (project nav "Publishing", Phase H5/H6.1).
 *
 * Connect output channels (websites and social) and publish project content to
 * them. Everything is capability/catalog driven: connected publishers are
 * grouped by descriptor category, capability chips come from normalized tokens,
 * and the composer only offers intents (article/text) the selected publisher
 * can actually carry - no hardcoded vendors or capabilities in the view.
 * Status is honest end-to-end: a queued job stays queued, a failure stays a
 * failure on the row and in job history. OAuth publishers render a
 * "Connect with <name>" button that does a full-tab consent redirect and lands
 * back on this view with `?x=connected` / `?oauth_error=...` query params.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, fmtDate, useJobs, JobTable, StatusPill, Empty } from '../lib/ui';
import { defaultPublishKind, PUBLISH_KIND_LABELS, publisherCapabilityChips, supportedPublishKinds, categoryLabel } from '../lib/publishers';
import type { PublishContentKind } from '@seo/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface SetupField {
  key: string;
  label: string;
  type?: 'text' | 'url' | 'password';
  placeholder?: string;
}
interface Descriptor {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  setup?: {
    category?: string;
    auth?: 'form' | 'oauth';
    config?: SetupField[];
    credentials?: SetupField[];
    note?: string;
  };
}
interface PubRow {
  id: string;
  name: string;
  provider: string;
  status: string;
  config: Record<string, unknown>;
  capabilities: string[];
}
interface PubWrap {
  publisher: PubRow;
  descriptor: Descriptor | null;
}
interface Publication {
  id: string;
  content_title: string | null;
  publisher_name: string | null;
  schedule_id: string | null;
  status: string;
  target_url: string | null;
  error: string | null;
  published_at: string | null;
  created_at: string;
}

const CATEGORY_ORDER = ['website', 'social'];

/** Intents the direct composer can express today (article body or a text post). */
const SOURCE_KINDS: PublishContentKind[] = ['article', 'text'];

/** Kinds a publisher can carry that this composer can produce. */
function usableKinds(wrap: PubWrap): PublishContentKind[] {
  return supportedPublishKinds(wrap.publisher, wrap.descriptor).filter((k) => SOURCE_KINDS.includes(k));
}

/**
 * Orchestrates the Publishing view: provider add buttons, grouped publisher
 * cards, the direct-composer for connected publishers, and a publication +
 * publish-job history. Props: `projectId` scopes every API call.
 */
export function Publishing({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => setRefresh((x) => x + 1);
  const pubs = useAsync<PubWrap[]>(() => api(`/projects/${projectId}/publishers`), [projectId, refresh]);
  const catalog = useAsync<{ publishers: { id: string; name: string }[] }>(() => api('/providers'), []);
  const list = useAsync<Publication[]>(() => api(`/projects/${projectId}/publications?limit=200`), [projectId, refresh]);
  const { jobs } = useJobs(projectId, true);

  // A full-tab OAuth connect bounces through the vendor consent screen and back
  // to this view; surface the outcome and clear the query params.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('x');
    const oauthError = params.get('oauth_error');
    if (connected === 'connected') {
      setNotice('X connected successfully.');
      window.history.replaceState({}, '', window.location.pathname + window.location.search.replace(/[?&](x|oauth_error)=[^&]*/g, '').replace(/^&/, '?'));
      reload();
    } else if (oauthError) {
      setErr(`X connect failed (${oauthError}).`);
      window.history.replaceState({}, '', window.location.pathname + window.location.search.replace(/[?&](x|oauth_error)=[^&]*/g, '').replace(/^&/, '?'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catalogProviders = catalog.data?.publishers ?? [];

  const action = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const addPublisher = (provider: string) =>
    action(() => api(`/projects/${projectId}/publishers`, { method: 'POST', body: { provider } }));

  // Group connected/configured publisher cards by category (website/social).
  const grouped = useMemo(() => {
    const groups = new Map<string, PubWrap[]>();
    for (const wrap of pubs.data ?? []) {
      const category = wrap.descriptor?.setup?.category ?? '';
      const list = groups.get(category) ?? [];
      list.push(wrap);
      groups.set(category, list);
    }
    const keys = [...groups.keys()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
    );
    return keys.map((category) => ({ category, wraps: groups.get(category) ?? [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubs.data]);

  const connectedCapable = (pubs.data ?? []).filter(
    (p) => p.publisher.status === 'connected' && usableKinds(p).length > 0,
  );

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Publishing"
        description="Connect output channels (websites and social) and publish project content to them."
      />
      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{notice}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {catalogProviders.map((d) => (
          <Button key={d.id} onClick={() => void addPublisher(d.id)}>
            + Add {d.name}
          </Button>
        ))}
        {catalogProviders.length === 0 && (
          <span className="text-sm text-muted-foreground">No publisher plugins registered on this server.</span>
        )}
      </div>

      {grouped.map(({ category, wraps }) => (
        <section key={category || 'other'} className="grid gap-3">
          {category && <h3 className="text-sm font-medium capitalize text-muted-foreground">{categoryLabel(category)}</h3>}
          {wraps.map(({ publisher, descriptor }) => (
            <PublisherCard key={publisher.id} projectId={projectId} publisher={publisher} descriptor={descriptor} onChanged={reload} onError={setErr} />
          ))}
        </section>
      ))}
      {(pubs.data ?? []).length === 0 && <Empty>No publishers yet. Add one above to start publishing.</Empty>}

      {connectedCapable.length > 0 && (
        <NewPublication projectId={projectId} publishers={connectedCapable} onDone={reload} onError={setErr} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Publications</CardTitle>
        </CardHeader>
        <CardContent>
          {(list.data ?? []).length === 0 && <Empty>Nothing published yet.</Empty>}
          {(list.data ?? []).length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data!.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.content_title ?? 'Untitled'}</TableCell>
                    <TableCell>
                      <StatusPill status={p.status} />
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{p.target_url || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.published_at ? fmtDate(p.published_at) : fmtDate(p.created_at)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void action(() =>
                            api(`/projects/${projectId}/publications/${p.id}/actions`, {
                              method: 'POST',
                              body: { action: 'publish', remote_status: 'publish' },
                            }),
                          )
                        }
                      >
                        Publish
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publish jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable jobs={jobs.filter((j) => String(j.job_type).startsWith('publish_') || j.job_type === 'publish')} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One publisher card. Renders descriptor-driven setup: config fields ("site
 * settings"), encrypted credential fields, an OAuth "Connect with <name>"
 * button when the descriptor says `auth: 'oauth'`, capability chips and
 * test/disconnect/delete actions. Credentials and config are posted to the
 * project-scoped publisher endpoints and never rendered back.
 */
function PublisherCard({
  projectId,
  publisher,
  descriptor,
  onChanged,
  onError,
}: {
  projectId: string;
  publisher: PubRow;
  descriptor: Descriptor | null;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const id = publisher.id;
  const connected = publisher.status === 'connected';
  const [busy, setBusy] = useState<string | null>(null);

  const setup = descriptor?.setup;
  const configFields = setup?.config ?? [];
  const credFields = setup?.credentials ?? [];
  const oauthMode = setup?.auth === 'oauth';
  const chips = publisherCapabilityChips(publisher.capabilities.length > 0 ? publisher.capabilities : descriptor?.capabilities);

  const connectedLabel = (() => {
    const cfg = publisher.config ?? {};
    const handle = typeof cfg['remote_account_username'] === 'string' ? cfg['remote_account_username'] : '';
    if (handle) return `@${handle}`;
    return typeof cfg['remote_account_name'] === 'string' ? (cfg['remote_account_name'] as string) : null;
  })();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of configFields) init[f.key] = String((publisher.config ?? {})[f.key] ?? '');
    return init;
  });
  const [creds, setCreds] = useState<Record<string, string>>({});

  const action = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async () => {
    const patch: Record<string, string> = {};
    for (const f of configFields) {
      const v = (values[f.key] ?? '').trim();
      if (v) patch[f.key] = v;
    }
    if (Object.keys(patch).length === 0) return;
    await api(`/projects/${projectId}/publishers/${id}/config`, { method: 'POST', body: { config: patch } });
  };

  const saveCredentials = async () => {
    for (const f of credFields) {
      const v = (creds[f.key] ?? '').trim();
      if (v) await api(`/projects/${projectId}/publishers/${id}/credentials`, { method: 'POST', body: { key: f.key, value: v } });
    }
    setCreds({});
  };

  const connectOauth = async () => {
    const r = await api<{ url: string }>(`/projects/${projectId}/publishers/${id}/oauth-url`, { method: 'POST' });
    // Full-tab navigation to the consent screen; the callback returns here with
    // ?x=connected (or ?oauth_error=...) and Publishing reloads.
    window.location.href = r.url;
  };

  const disconnect = async () => {
    await api(`/projects/${projectId}/publishers/${id}/disconnect`, { method: 'POST' });
  };

  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <b>{descriptor?.name ?? publisher.name}</b>
          <StatusPill status={publisher.status} />
          <span className="font-mono text-xs text-muted-foreground">{publisher.provider}</span>
          {categoryLabel(setup?.category) && <Badge variant="outline">{categoryLabel(setup?.category)}</Badge>}
          <span className="flex-1" />
          {busy && <Badge variant="warning">{busy}…</Badge>}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Badge key={c} variant="outline" title="Capability this channel supports">
                {c}
              </Badge>
            ))}
          </div>
        )}

        {setup?.note && <p className="text-[13px] text-muted-foreground">{setup.note}</p>}

        {configFields.length > 0 && (
          <div className="grid gap-2">
            <label className="text-sm font-medium">Site settings</label>
            {configFields.map((f) => (
              <Input
                key={f.key}
                type={f.type ?? 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? f.label}
              />
            ))}
            <div>
              <Button variant="outline" disabled={busy !== null} onClick={() => void action('config', () => saveConfig())}>
                Save settings
              </Button>
            </div>
          </div>
        )}

        {credFields.length > 0 && (
          <div className="grid gap-2">
            <label className="text-sm font-medium">Credentials (encrypted at rest)</label>
            <div className="flex flex-wrap gap-2">
              {credFields.map((f) => (
                <Input
                  key={f.key}
                  className="w-[220px]"
                  type={f.type ?? 'password'}
                  value={creds[f.key] ?? ''}
                  onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? f.label}
                />
              ))}
              <Button
                variant="outline"
                disabled={busy !== null || !credFields.some((f) => (creds[f.key] ?? '').trim().length > 0)}
                onClick={() => void action('creds', saveCredentials)}
              >
                Save credentials
              </Button>
            </div>
          </div>
        )}

        {oauthMode && (
          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <>
                <span className="text-[13px] text-muted-foreground">
                  {connectedLabel ? `Connected as ${connectedLabel}` : 'Connected'}
                </span>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void action('disconnect', disconnect)}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button disabled={busy !== null} onClick={() => void action('connect', connectOauth)}>
                Connect with {descriptor?.name ?? publisher.name}
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy !== null || (oauthMode && !connected)}
            onClick={() => void action('test', () => api(`/projects/${projectId}/publishers/${id}/test`, { method: 'POST' }))}
          >
            {connected ? 'Re-test connection' : 'Test connection'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={busy !== null}
            onClick={() => void action('del', () => api(`/projects/${projectId}/publishers/${id}`, { method: 'DELETE' }))}
          >
            Delete publisher
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Direct publication composer (article body or text post). Only lists
 * connected publishers that can carry at least one of this composer's kinds,
 * and only offers intents the selected publisher supports; submitting enqueues
 * a publication job through the API rather than claiming an instant success.
 */
function NewPublication({
  projectId,
  publishers,
  onDone,
  onError,
}: {
  projectId: string;
  publishers: PubWrap[];
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [publisherId, setPublisherId] = useState(publishers[0]?.publisher.id ?? '');
  const [publishKind, setPublishKind] = useState<PublishContentKind>(() => {
    const first = publishers[0];
    if (!first) return 'article';
    const kinds = usableKinds(first);
    const preferred = defaultPublishKind(first.publisher, first.descriptor);
    return kinds.includes(preferred) ? preferred : (kinds[0] ?? 'article');
  });
  const [status, setStatus] = useState<'publish' | 'draft'>('publish');
  const [busy, setBusy] = useState(false);

  const selected = publishers.find((p) => p.publisher.id === publisherId) ?? publishers[0];
  const selectedKinds = selected ? usableKinds(selected) : [];

  const selectPublisher = (idValue: string) => {
    setPublisherId(idValue);
    const wrap = publishers.find((p) => p.publisher.id === idValue);
    if (!wrap) return;
    const kinds = usableKinds(wrap);
    if (kinds.length === 0) return;
    const preferred = defaultPublishKind(wrap.publisher, wrap.descriptor);
    const chosen = kinds.includes(preferred) ? preferred : kinds[0];
    if (chosen) setPublishKind(chosen);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const finalKind = selectedKinds.includes(publishKind) ? publishKind : selectedKinds[0];
      await api(`/projects/${projectId}/publications`, {
        method: 'POST',
        body: {
          publisher_id: publisherId,
          publish_kind: finalKind,
          title,
          content,
          excerpt: excerpt || undefined,
          remote_status: status,
        },
      });
      setTitle('');
      setContent('');
      setExcerpt('');
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New publication</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="pub-publisher">
          Publisher
        </label>
        <select
          id="pub-publisher"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={publisherId}
          onChange={(e) => selectPublisher(e.target.value)}
        >
          {publishers.map((p) => (
            <option key={p.publisher.id} value={p.publisher.id}>
              {p.descriptor?.name ?? p.publisher.name}
            </option>
          ))}
        </select>
        {selectedKinds.length > 1 && (
          <>
            <label className="text-sm font-medium">Publish as</label>
            <div className="flex flex-wrap gap-4">
              {selectedKinds.map((k) => (
                <label key={k} className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="publish-kind"
                    value={k}
                    checked={publishKind === k}
                    onChange={() => setPublishKind(k)}
                  />
                  {PUBLISH_KIND_LABELS[k]}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="text-sm font-medium" htmlFor="pub-title">
          Title
        </label>
        <Input id="pub-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="text-sm font-medium" htmlFor="pub-content">
          Content (markdown or plain text)
        </label>
        <Textarea id="pub-content" value={content} onChange={(e) => setContent(e.target.value)} />
        <label className="text-sm font-medium" htmlFor="pub-excerpt">
          Excerpt (optional)
        </label>
        <Input id="pub-excerpt" type="text" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'publish' | 'draft')}
          >
            <option value="publish">Publish now</option>
            <option value="draft">Save as draft</option>
          </select>
          <Button disabled={busy || !title.trim() || !publisherId} onClick={() => void submit()}>
            {busy ? 'Queuing…' : 'Queue publication'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

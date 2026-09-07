import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, fmtDate, useJobs, JobTable, StatusPill, Empty } from '../lib/ui';
import { defaultPublishKind, PUBLISH_KIND_LABELS, publisherCapabilityChips, supportedPublishKinds, categoryLabel } from '../lib/publishers';
import type { PublishContentKind } from '@seo/contracts';

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
    <div>
      <h1>Publishing</h1>
      <p className="sub">Connect output channels (websites and social) and publish project content to them.</p>
      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner">{notice}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {catalogProviders.map((d) => (
          <button key={d.id} className="btn primary" onClick={() => void addPublisher(d.id)}>
            + Add {d.name}
          </button>
        ))}
        {catalogProviders.length === 0 && <span className="muted">No publisher plugins registered on this server.</span>}
      </div>

      {grouped.map(({ category, wraps }) => (
        <section key={category || 'other'} className="mb">
          {category && <h3 className="sub" style={{ textTransform: 'capitalize' }}>{categoryLabel(category)}</h3>}
          {wraps.map(({ publisher, descriptor }) => (
            <PublisherCard key={publisher.id} projectId={projectId} publisher={publisher} descriptor={descriptor} onChanged={reload} onError={setErr} />
          ))}
        </section>
      ))}
      {(pubs.data ?? []).length === 0 && <Empty>No publishers yet. Add one above to start publishing.</Empty>}

      {connectedCapable.length > 0 && (
        <NewPublication projectId={projectId} publishers={connectedCapable} onDone={reload} onError={setErr} />
      )}

      <div className="card mt">
        <h2>Publications</h2>
        {(list.data ?? []).length === 0 && <Empty>Nothing published yet.</Empty>}
        {(list.data ?? []).length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>URL</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data!.map((p) => (
                <tr key={p.id}>
                  <td>{p.content_title ?? 'Untitled'}</td>
                  <td>
                    <StatusPill status={p.status} />
                  </td>
                  <td className="mono muted">{p.target_url || '—'}</td>
                  <td className="muted">{p.published_at ? fmtDate(p.published_at) : fmtDate(p.created_at)}</td>
                  <td>
                    <button
                      className="btn sm"
                      onClick={() => void action(() => api(`/projects/${projectId}/publications/${p.id}/actions`, { method: 'POST', body: { action: 'publish', remote_status: 'publish' } }))}
                    >
                      Publish
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt">
        <h2>Publish jobs</h2>
        <JobTable jobs={jobs.filter((j) => String(j.job_type).startsWith('publish_') || j.job_type === 'publish')} />
      </div>
    </div>
  );
}

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
    <div className="card mb">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <b>{descriptor?.name ?? publisher.name}</b>
        <StatusPill status={publisher.status} />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {publisher.provider}
        </span>
        {categoryLabel(setup?.category) && <span className="pill">{categoryLabel(setup?.category)}</span>}
        <span style={{ flex: 1 }} />
        {busy && <span className="pill busy">{busy}…</span>}
      </div>

      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          {chips.map((c) => (
            <span key={c} className="pill" title="Capability this channel supports">
              {c}
            </span>
          ))}
        </div>
      )}

      {setup?.note && <p className="muted" style={{ fontSize: 13 }}>{setup.note}</p>}

      {configFields.length > 0 && (
        <>
          <label className="fld">Site settings</label>
          {configFields.map((f) => (
            <div key={f.key} className="row">
              <input
                type={f.type ?? 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? f.label}
                style={{ flex: 1 }}
              />
            </div>
          ))}
          <div className="row">
            <button className="btn" disabled={busy !== null} onClick={() => void action('config', () => saveConfig())}>
              Save settings
            </button>
          </div>
        </>
      )}

      {credFields.length > 0 && (
        <>
          <label className="fld">Credentials (encrypted at rest)</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {credFields.map((f) => (
              <input
                key={f.key}
                type={f.type ?? 'password'}
                value={creds[f.key] ?? ''}
                onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? f.label}
              />
            ))}
            <button
              className="btn"
              disabled={busy !== null || !credFields.some((f) => (creds[f.key] ?? '').trim().length > 0)}
              onClick={() => void action('creds', saveCredentials)}
            >
              Save credentials
            </button>
          </div>
        </>
      )}

      {oauthMode && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {connected ? (
            <>
              <span className="muted" style={{ fontSize: 13, marginRight: 8 }}>
                {connectedLabel ? `Connected as ${connectedLabel}` : 'Connected'}
              </span>
              <button className="btn sm" disabled={busy !== null} onClick={() => void action('disconnect', disconnect)}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={busy !== null} onClick={() => void action('connect', connectOauth)}>
              Connect with {descriptor?.name ?? publisher.name}
            </button>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn primary"
          disabled={busy !== null || (oauthMode && !connected)}
          onClick={() => void action('test', () => api(`/projects/${projectId}/publishers/${id}/test`, { method: 'POST' }))}
        >
          {connected ? 'Re-test connection' : 'Test connection'}
        </button>
        <button className="btn sm danger" disabled={busy !== null} onClick={() => void action('del', () => api(`/projects/${projectId}/publishers/${id}`, { method: 'DELETE' }))}>
          Delete publisher
        </button>
      </div>
    </div>
  );
}

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
    <div className="card mt">
      <h2>New publication</h2>
      <label className="fld">Publisher</label>
      <select value={publisherId} onChange={(e) => selectPublisher(e.target.value)}>
        {publishers.map((p) => (
          <option key={p.publisher.id} value={p.publisher.id}>
            {p.descriptor?.name ?? p.publisher.name}
          </option>
        ))}
      </select>
      {selectedKinds.length > 1 && (
        <>
          <label className="fld">Publish as</label>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {selectedKinds.map((k) => (
              <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
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
      <label className="fld">Title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
      <label className="fld">Content (markdown or plain text)</label>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} />
      <label className="fld">Excerpt (optional)</label>
      <input type="text" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} style={{ width: '100%' }} />
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value as 'publish' | 'draft')}>
          <option value="publish">Publish now</option>
          <option value="draft">Save as draft</option>
        </select>
        <button className="btn primary" disabled={busy || !title.trim() || !publisherId} onClick={() => void submit()}>
          {busy ? 'Queuing…' : 'Queue publication'}
        </button>
      </div>
    </div>
  );
}

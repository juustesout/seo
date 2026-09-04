import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync, fmtDate, useJobs, JobTable, StatusPill, Empty } from '../lib/ui';

interface PubRow {
  id: string;
  name: string;
  provider: string;
  status: string;
  config: Record<string, unknown>;
}
interface PubWrap {
  publisher: PubRow;
  descriptor: { name: string; id: string; description: string } | null;
}
interface Publication {
  id: string;
  title: string;
  status: string;
  target_url: string | null;
  error: string | null;
  created_at: string;
}

export function Publishing({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => setRefresh((x) => x + 1);
  const pubs = useAsync<PubWrap[]>(() => api(`/projects/${projectId}/publishers`), [projectId, refresh]);
  const catalog = useAsync<{ publishers: { id: string; name: string; description: string }[] }>(
    () => api('/providers'),
    [],
  );
  const list = useAsync<Publication[]>(() => api(`/projects/${projectId}/publications`), [projectId, refresh]);
  const { jobs } = useJobs(projectId, true);

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

  return (
    <div>
      <h1>Publishing</h1>
      <p className="sub">Connect content channels (WordPress) and publish project content to them.</p>
      {err && <div className="banner error">{err}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {catalogProviders.map((d) => (
          <button key={d.id} className="btn primary" onClick={() => void addPublisher(d.id)}>
            + Add {d.name}
          </button>
        ))}
        {catalogProviders.length === 0 && <span className="muted">No publisher plugins registered on this server.</span>}
      </div>

      {(pubs.data ?? []).map(({ publisher, descriptor }) => (
        <PublisherCard key={publisher.id} projectId={projectId} publisher={publisher} descriptor={descriptor} onChanged={reload} onError={setErr} />
      ))}
      {(pubs.data ?? []).length > 0 && (pubs.data ?? []).length === 0 && <Empty>No publishers.</Empty>}

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
                  <td>{p.title}</td>
                  <td>
                    <StatusPill status={p.status} />
                  </td>
                  <td className="mono muted">{p.target_url || '—'}</td>
                  <td className="muted">{fmtDate(p.created_at)}</td>
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

      {(pubs.data ?? []).some((p) => p.publisher.status === 'connected') && (
        <NewPublication projectId={projectId} publishers={(pubs.data ?? []).filter((p) => p.publisher.status === 'connected')} onDone={reload} onError={setErr} />
      )}

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
  descriptor: { name: string } | null;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const id = publisher.id;
  const connected = publisher.status === 'connected';
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState(String(publisher.config?.base_url ?? ''));
  const [user, setUser] = useState('');
  const [appPass, setAppPass] = useState('');

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

  return (
    <div className="card mb">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <b>{descriptor?.name ?? publisher.name}</b>
        <StatusPill status={publisher.status} />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {publisher.provider}
        </span>
        <span style={{ flex: 1 }} />
        {busy && <span className="pill busy">{busy}…</span>}
      </div>

      <label className="fld">Site URL (REST root, e.g. https://example.com)</label>
      <div className="row">
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" style={{ flex: 1 }} />
        <button className="btn" disabled={busy !== null} onClick={() => void action('config', () => api(`/projects/${projectId}/publishers/${id}/config`, { method: 'POST', body: { base_url: url } }))}>
          Save URL
        </button>
      </div>
      <label className="fld">WordPress username / application password (encrypted at rest)</label>
      <div className="row">
        <input type="text" value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" />
        <input type="password" value={appPass} onChange={(e) => setAppPass(e.target.value)} placeholder="application password" />
        <button
          className="btn"
          disabled={busy !== null || (!user && !appPass)}
          onClick={() =>
            void action('creds', async () => {
              if (user) await api(`/projects/${projectId}/publishers/${id}/credentials`, { method: 'POST', body: { key: 'wordpress_username', value: user } });
              if (appPass) await api(`/projects/${projectId}/publishers/${id}/credentials`, { method: 'POST', body: { key: 'wordpress_application_password', value: appPass } });
            })
          }
        >
          Save credentials
        </button>
        <button className="btn primary" disabled={busy !== null} onClick={() => void action('test', () => api(`/projects/${projectId}/publishers/${id}/test`, { method: 'POST' }))}>
          {connected ? 'Re-test' : 'Test connection'}
        </button>
      </div>
      <button className="btn sm danger" disabled={busy !== null} onClick={() => void action('del', () => api(`/projects/${projectId}/publishers/${id}`, { method: 'DELETE' }))}>
        Delete publisher
      </button>
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
  const [status, setStatus] = useState<'publish' | 'draft'>('publish');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/projects/${projectId}/publications`, {
        method: 'POST',
        body: { publisher_id: publisherId, title, content, excerpt: excerpt || undefined, remote_status: status },
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
      <select value={publisherId} onChange={(e) => setPublisherId(e.target.value)}>
        {publishers.map((p) => (
          <option key={p.publisher.id} value={p.publisher.id}>
            {p.descriptor?.name ?? p.publisher.name}
          </option>
        ))}
      </select>
      <label className="fld">Title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
      <label className="fld">Content (markdown)</label>
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

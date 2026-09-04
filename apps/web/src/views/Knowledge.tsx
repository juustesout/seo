import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync, num, useJobs, JobTable, Empty } from '../lib/ui';

interface Status {
  provider: { id: string; name: string; description: string } | null;
  configured: boolean;
  note: string;
}
interface Hit {
  id?: string;
  score?: number;
  payload?: Record<string, unknown>;
}

export function Knowledge({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useAsync<Status>(() => api(`/projects/${projectId}/knowledge/status`), [projectId, refresh]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);
  const { jobs, busy } = useJobs(projectId, true);

  const search = async () => {
    setErr(null);
    setSearching(true);
    try {
      const r = await api<{ results: Hit[] }>(`/projects/${projectId}/knowledge/search`, {
        method: 'POST',
        body: { query: query.trim(), limit: 10 },
      });
      setResults(r.results);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const indexNow = async () => {
    setErr(null);
    setNotice(null);
    setEnqueuing(true);
    try {
      const r = await api<{ job: { id: string } }>(`/projects/${projectId}/jobs`, {
        method: 'POST',
        body: { job_type: 'knowledge_index', params: {} },
      });
      setNotice(`Index job queued (${r.job.id.slice(0, 8)}…). See jobs below for progress.`);
      setTimeout(() => setRefresh((x) => x + 1), 800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnqueuing(false);
    }
  };

  const configured = status.data?.configured ?? false;

  return (
    <div>
      <h1>Knowledge Base</h1>
      <p className="sub">
        Semantic search over the content and data this project has collected (Qdrant, per-project isolated collection).
      </p>

      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="card mb">
        <h2>Status</h2>
        {status.loading ? (
          <p className="muted">Loading…</p>
        ) : status.data?.provider ? (
          <>
            <p>
              Provider: <b>{status.data.provider.name}</b> · {configured ? <span className="pill ok">configured</span> : <span className="pill err">not configured</span>}
            </p>
            {!configured && (
              <div className="banner">
                Qdrant or the embedding key (EMBEDDINGS_API_KEY) is missing on the API server. Add them to run semantic search
                and indexing.
              </div>
            )}
            <p className="muted">{status.data.note}</p>
            {configured && (
              <button className="btn primary" disabled={enqueuing} onClick={() => void indexNow()}>
                {enqueuing ? 'Queuing…' : 'Rebuild index (background job)'}
              </button>
            )}
          </>
        ) : (
          <Empty>{status.data?.note ?? 'No knowledge provider.'}</Empty>
        )}
      </div>

      {configured && (
        <div className="card mb">
          <h2>Search</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What have we learned about…" style={{ flex: 1 }} />
            <button className="btn primary" disabled={searching || !query.trim()}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
          {results && (
            <div>
              {results.length === 0 && <Empty>No matches.</Empty>}
              {results.map((h, i) => {
                const p = h.payload ?? {};
                return (
                  <div key={String(h.id ?? i)} className="card" style={{ background: 'var(--panel-2)', marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <b>{String(p.title ?? '(untitled)')}</b>
                      <span className="pill">{h.score != null ? num(h.score).toFixed(3) : ''}</span>
                    </div>
                    <div className="mono muted" style={{ fontSize: 12, margin: '4px 0' }}>
                      {String(p.url ?? p.source ?? p.kind ?? '')}
                    </div>
                    <p className="muted" style={{ margin: 0 }}>
                      {String(p.text ?? p.excerpt ?? '').slice(0, 300)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Indexing jobs {busy && <span className="pill busy">running…</span>}</h2>
        <JobTable jobs={jobs.filter((j) => j.job_type.startsWith('knowledge_'))} />
      </div>
    </div>
  );
}

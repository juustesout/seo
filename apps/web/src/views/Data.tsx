import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync, num, fmtNum, fmtDate, useJobs, JobTable, Empty } from '../lib/ui';

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
    <div>
      <h1>Keywords & Rankings</h1>
      <p className="sub">Research and track keywords against Google via DataForSEO; results land in this project only.</p>
      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="card mb">
        <h2>Run jobs</h2>
        <label className="fld">Keyword research seeds (one per line, max 20)</label>
        <textarea value={seeds} onChange={(e) => setSeeds(e.target.value)} placeholder={'seo platform\nrank tracker'} />
        <button className="btn primary" disabled={enqueuing !== null} onClick={() => void runResearch()}>
          {enqueuing === 'dataforseo_keyword_research' ? 'Enqueuing…' : 'Research keywords (DataForSEO)'}
        </button>
        <label className="fld">Rank-tracking keywords (extra, comma separated; merges with tracked)</label>
        <input type="text" value={extraKw} onChange={(e) => setExtraKw(e.target.value)} placeholder="local seo tools, seo audit" />
        <button className="btn primary" disabled={enqueuing !== null} onClick={() => void runRankSync()}>
          {enqueuing === 'serp_retrieval' ? 'Enqueuing…' : 'Track SERP positions'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {tabs.map((t) => (
          <button key={t.id} className={`btn ${tab === t.id ? 'primary' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card">
        {tab === 'keywords' && (
          <>
            {(keywords.data?.keywords ?? []).length === 0 && <Empty>No keywords yet — run a research job above.</Empty>}
            {keywords.data && (keywords.data.keywords.length > 0) && (
              <table>
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th className="num">Volume</th>
                    <th className="num">Difficulty</th>
                    <th className="num">CPC</th>
                    <th>Intent</th>
                    <th>Source</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.data.keywords.map((k) => (
                    <tr key={k.keyword}>
                      <td>{k.keyword}</td>
                      <td className="num">{k.volume != null ? fmtNum(k.volume) : '—'}</td>
                      <td className="num">{k.difficulty != null ? num(k.difficulty).toFixed(0) : '—'}</td>
                      <td className="num">{k.cpc != null ? `$${num(k.cpc).toFixed(2)}` : '—'}</td>
                      <td>{k.intent || '—'}</td>
                      <td className="mono">{k.source || '—'}</td>
                      <td className="muted">{fmtDate(k.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {tab === 'pages' && (
          <>
            {(pages.data?.pages ?? []).length === 0 && <Empty>No pages tracked yet.</Empty>}
            {pages.data && pages.data.pages.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th className="num">Status</th>
                    <th className="num">Words</th>
                    <th>Indexable</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {pages.data.pages.map((p) => (
                    <tr key={p.url}>
                      <td className="mono">{p.url}</td>
                      <td className="num">{p.status_code ?? '—'}</td>
                      <td className="num">{p.word_count != null ? fmtNum(p.word_count) : '—'}</td>
                      <td>{p.is_indexable == null ? '—' : p.is_indexable ? 'yes' : 'no'}</td>
                      <td className="muted">{fmtDate(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                <p className="muted">Snapshot date: {rankings.data.date}</p>
                <table>
                  <thead>
                    <tr>
                      <th className="num">Pos</th>
                      <th>Keyword</th>
                      <th>URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankings.data.rankings.map((r, i) => (
                      <tr key={`${r.keyword}-${i}`}>
                        <td className="num">
                          {r.position && r.position <= 3 ? (
                            <b style={{ color: '#6ee7a0' }}>{r.position}</b>
                          ) : (
                            r.position ?? '—'
                          )}
                        </td>
                        <td>{r.keyword}</td>
                        <td className="mono muted">{r.url || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>

      <div className="card mt">
        <h2>
          Recent jobs {busy && <span className="pill busy">working…</span>}
        </h2>
        <JobTable jobs={jobs} />
      </div>
    </div>
  );
}

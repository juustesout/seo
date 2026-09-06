import { useState } from 'react';
import { useAsync, fmtNum, fmtDate } from '../lib/ui';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';

interface AccountProject {
  id: string;
  name: string;
  role: string;
  website_url: string | null;
  connected_count: number;
  integration_count: number;
  content_count: number;
  last_sync_at: string | null;
  created_at: string;
  property: { property_id: string; site_url: string; is_primary: boolean } | null;
}

export function ProjectsPage({ onOpenProject }: { onOpenProject: (id: string, view: string) => void }) {
  const { data, error, loading, reload } = useAsync<{ projects: AccountProject[] }>(() => api('/account'), []);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (!supabase) throw new Error('Supabase not configured');
      const { data: row, error: rpcError } = await supabase.rpc('seo_create_project', {
        p_name: name.trim(),
        p_website_url: url.trim() || null,
        p_description: null,
      });
      if (rpcError) throw new Error(rpcError.message);
      const id = (Array.isArray(row) ? row[0] : row)?.id as string | undefined;
      if (!id) throw new Error('Project was created but returned no id');
      onOpenProject(id, 'dashboard');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="banner error">{error}</div>;
  const projects = data?.projects ?? [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>Projects</h1>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            Isolated SEO workspaces: keywords, rankings, content and publishing live per project.
          </p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : 'New project'}
        </button>
      </div>

      {showForm && (
        <div className="card mt">
          <h2>Create a project</h2>
          <label className="fld">Project name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme marketing site" style={{ width: '100%' }} />
          <label className="fld">Website URL (optional)</label>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" style={{ width: '100%' }} />
          {err && <div className="error-line">{err}</div>}
          <div className="mt">
            <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card mt">
          <p className="muted">No projects yet. Create one to start tracking keywords, rankings and content.</p>
        </div>
      ) : (
        <div className="grid mt">
          {projects.map((p) => (
            <div className="card" key={p.id}>
              <div className="label" style={{ fontSize: 13 }}>
                {p.property ? <span className="pill ok">{p.property.site_url}</span> : <span className="pill">no GSC property</span>}
              </div>
              <h3 style={{ margin: '6px 0' }}>{p.name}</h3>
              <p className="muted" style={{ minHeight: 34 }}>
                {p.website_url ?? 'No website set'} · {p.role}
              </p>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                {fmtNum(p.integration_count)} integrations · {fmtNum(p.connected_count)} connected · {fmtNum(p.content_count)} content · created {fmtDate(p.created_at)}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm primary" onClick={() => onOpenProject(p.id, 'dashboard')}>
                  Open
                </button>
                <button className="btn sm" onClick={() => onOpenProject(p.id, 'settings')}>
                  Settings
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

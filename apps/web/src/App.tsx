import { useEffect, useMemo, useState } from 'react';
import { supabase, configured as supabaseConfigured, currentUser, sessionToken } from './lib/supabase';
import { api } from './lib/api';
import { Dashboard } from './views/Dashboard';
import { Integrations } from './views/Integrations';
import { DataViews } from './views/Data';
import { Knowledge } from './views/Knowledge';
import { Publishing } from './views/Publishing';

interface ProjectRow {
  id: string;
  name: string;
  role: string;
  website_url: string | null;
  connected_count: number;
  integration_count: number;
  last_sync_at: string | null;
  created_at: string;
}

interface Me {
  user_id: string;
  email: string | null;
  projects: ProjectRow[];
}

interface Route {
  projectId: string | null;
  view: string;
}

function parseRoute(): Route {
  const seg = window.location.pathname.split('/').filter(Boolean);
  if (seg[0] === 'p' && seg[1]) return { projectId: seg[1], view: seg[2] || 'dashboard' };
  return { projectId: null, view: 'home' };
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard', dot: true },
  { id: 'data', label: 'Keywords & Rankings', dot: true },
  { id: 'integrations', label: 'Integrations', dot: true },
  { id: 'knowledge', label: 'Knowledge Base', dot: false },
  { id: 'publishing', label: 'Publishing', dot: false },
];

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [session, setSession] = useState<{ email: string | null } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const onLoc = () => setRoute(parseRoute());
    window.addEventListener('popstate', onLoc);
    return () => window.removeEventListener('popstate', onLoc);
  }, []);

  useEffect(() => {
    (async () => {
      if (!supabaseConfigured) {
        setBootError('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing in apps/web/.env');
        setAuthed(false);
        return;
      }
      const u = await currentUser();
      setSession(u ? { email: u.email } : null);
      setAuthed(Boolean(u));
      if (u) {
        try {
          const m = await api<Me>('/me');
          setMe(m);
          const first = m.projects[0];
          if (first && !parseRoute().projectId) {
            go(first.id, parseRoute().view === 'home' ? 'dashboard' : parseRoute().view);
          }
        } catch (e) {
          setBootError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
  }, [authed]);

  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s?.user ? { email: s.user.email ?? null } : null);
      setAuthed(Boolean(s?.user));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const go = (projectId: string | null, view: string) => {
    if (projectId) {
      window.history.pushState({}, '', `/p/${projectId}/${view}`);
    } else {
      window.history.pushState({}, '', '/');
    }
    setRoute({ projectId, view });
  };

  const meEmail = me?.email ?? session?.email ?? null;

  if (bootError && authed === false) {
    return (
      <div className="content" style={{ maxWidth: 520, margin: '10vh auto' }}>
        <div className="card">
          <h1>SEO Operating Platform</h1>
          <div className="banner error">{bootError}</div>
          <p className="muted">Configure Supabase keys, then reload. The API server must be running on :3001 for /api calls.</p>
        </div>
      </div>
    );
  }

  if (authed === false) {
    return <AuthScreen />;
  }

  if (authed === null || !me) {
    return (
      <div className="content" style={{ maxWidth: 520, margin: '10vh auto' }}>
        <div className="card">
          <h1>Loading…</h1>
          {bootError && <div className="banner error">{bootError}</div>}
        </div>
      </div>
    );
  }

  const firstProject = me.projects[0] ?? null;
  if (!firstProject) {
    return <CreateProject email={meEmail} onCreated={(id) => go(id, 'dashboard')} />;
  }

  const project = route.projectId
    ? (me.projects.find((p) => p.id === route.projectId) ?? null)
    : firstProject;

  if (!project) {
    // project belongs to another user or was deleted
    return (
      <ShellTop email={meEmail} onSignOut={() => void signOut()}>
        <div className="card">
          <div className="banner error">Project not found or you don't have access.</div>
          <button className="btn" onClick={() => go(firstProject.id, 'dashboard')}>
            Back to {firstProject.name}
          </button>
        </div>
      </ShellTop>
    );
  }

  const pid = project.id;
  return (
    <div>
      <ShellTop
        email={meEmail}
        onSignOut={() => void signOut()}
        project={project!}
        projects={me.projects}
        onPick={(id) => go(id, 'dashboard')}
      />
      <div className="layout">
        <nav className="side">
          {NAV.map((n) => (
            <div key={n.id} className={`nav-item ${route.view === n.id ? 'active' : ''}`} onClick={() => go(pid, n.id)}>
              {n.dot ? <span className="dot" /> : <span style={{ width: 6 }} />}
              {n.label}
            </div>
          ))}
        </nav>
        <main className="content">
          {route.view === 'dashboard' && <Dashboard projectId={pid} />}
          {route.view === 'data' && <DataViews projectId={pid} />}
          {route.view === 'integrations' && <Integrations projectId={pid} />}
          {route.view === 'knowledge' && <Knowledge projectId={pid} />}
          {route.view === 'publishing' && <Publishing projectId={pid} />}
        </main>
      </div>
    </div>
  );
}

async function signOut() {
  await supabase?.auth.signOut();
  window.location.href = '/';
}

function ShellTop(props: {
  email: string | null;
  onSignOut: () => void;
  project?: ProjectRow;
  projects?: ProjectRow[];
  onPick?: (id: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <span className="brand">SEO Ops</span>
      {props.project && props.projects && props.onPick && (
        <select className="project-select" value={props.project.id} onChange={(e) => props.onPick?.(e.target.value)}>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.role})
            </option>
          ))}
        </select>
      )}
      <div className="spacer" />
      <span className="muted">{props.email}</span>
      <button className="btn sm" onClick={props.onSignOut}>
        Sign out
      </button>
    </div>
  );
}

function CreateProject({ email, onCreated }: { email: string | null; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('seo_create_project', {
        p_name: name.trim(),
        p_website_url: url.trim() || null,
        p_description: desc.trim() || null,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      onCreated((row as { id?: string })?.id ?? '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ShellTop email={email} onSignOut={() => void signOut()} />
      <div className="content" style={{ maxWidth: 560 }}>
        <div className="card">
          <h1>Create your first project</h1>
          <p className="sub">
            A project is your isolated SEO workspace: provider connections, tracked keywords, rankings and content live here.
          </p>
          <label className="fld">Project name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme marketing site" style={{ width: '100%' }} />
          <label className="fld">Website URL (optional)</label>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" style={{ width: '100%' }} />
          <label className="fld">Description (optional)</label>
          <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ width: '100%' }} />
          {err && <div className="error-line">{err}</div>}
          <div className="mt">
            <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup' | 'code'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      if (!supabase) throw new Error('Supabase not configured');
      if (mode === 'code') {
        const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
        if (error) throw new Error(error.message);
        return;
      }
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        return;
      }
      const { error, data } = await supabase.auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      if (data.session) return; // auto-confirmed project
      setMode('code');
      setInfo('Check your inbox for a one-time code, then paste it below.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const magic = async () => {
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) throw new Error(error.message);
      setMode('code');
      setInfo('Magic link / code sent. Paste the code below after clicking the link.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content" style={{ maxWidth: 460, margin: '8vh auto' }}>
      <div className="card">
        <h1>SEO Operating Platform</h1>
        <p className="sub">Modular SEO platform: Search Console data, SERP tracking, keyword research and publishing in one project.</p>
        {!supabaseConfigured && <div className="banner error">Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.</div>}
        <label className="fld">Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
        {mode !== 'code' && (
          <>
            <label className="fld">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
          </>
        )}
        {mode === 'code' && (
          <>
            <label className="fld">One-time code</label>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: '100%' }} />
          </>
        )}
        {err && <div className="error-line">{err}</div>}
        {info && <div className="ok-line">{info}</div>}
        <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {mode !== 'code' ? (
            <button
              className="btn primary"
              onClick={() => void submit()}
              disabled={busy || !email || !password}
            >
              {busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          ) : (
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !code.trim()}>
              {busy ? '…' : 'Verify code'}
            </button>
          )}
          <button className="btn" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Create account instead' : 'Log in instead'}
          </button>
          {mode === 'code' && (
            <button className="btn" onClick={() => void magic()} disabled={busy || !email}>
              Re-send code
            </button>
          )}
        </div>
        {mode !== 'code' && (
          <div className="mt">
            <button className="btn" onClick={() => void magic()} disabled={busy || !email}>
              Email me a magic link instead
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Root application shell: session bootstrap, history-based routing and layout.
 *
 * Routes are plain URLs - account areas (`/`, `/projects`, `/integrations`,
 * `/keys`) and the project workspace (`/p/:projectId/:view`). Everything under
 * a project is project-scoped: children receive `projectId` plus the current
 * user's `role` in that project so they can gate edits/actions themselves. The
 * client holds no provider credentials; the only secret-ish thing it ever
 * sends is the Supabase session token attached by lib/api.ts.
 *
 * Bootstrap is staged: Supabase must be configured, then a session/user must
 * exist, then `/me` (account + project memberships) must resolve before any
 * workspace renders - children assume `me.projects` is already loaded.
 */
import { useEffect, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Loader2,
  Newspaper,
  PenSquare,
  Plug,
  Send,
  Settings,
} from 'lucide-react';
import { supabase, configured as supabaseConfigured, currentUser, sessionToken } from './lib/supabase';
import { api } from './lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Dashboard } from './views/Dashboard';
import { Integrations } from './views/Integrations';
import { DataViews } from './views/Data';
import { Knowledge } from './views/Knowledge';
import { Publishing } from './views/Publishing';
import { Content } from './views/Content';
import { ContentSchedule } from './views/ContentSchedule';
import { Publications } from './views/Publications';
import { openProjectView } from './lib/nav';
import { Overview } from './views/Overview';
import { AccountIntegrations } from './views/AccountIntegrations';
import { AccountApiKeys } from './views/AccountApiKeys';
import { ProjectsPage } from './views/ProjectsPage';
import { ProjectSettings } from './views/ProjectSettings';

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

type TopArea = 'overview' | 'projects' | 'integrations' | 'keys';
type Route =
  | { area: TopArea }
  | { area: 'project'; projectId: string; view: string };

type NavIcon = React.ComponentType<{ className?: string }>;

/** Derive the current Route from window.location.pathname. */
function parseRoute(): Route {
  const seg = window.location.pathname.split('/').filter(Boolean);
  if (seg[0] === 'p' && seg[1]) return { area: 'project', projectId: seg[1], view: seg[2] || 'dashboard' };
  const area = seg[0] === 'projects' || seg[0] === 'integrations' || seg[0] === 'keys' ? seg[0] : 'overview';
  return { area };
}

/** Render a Route back to its canonical URL path. */
function routePath(r: Route): string {
  if (r.area === 'project') return `/p/${r.projectId}/${r.view}`;
  return `/${r.area === 'overview' ? 'overview' : r.area}`;
}

const TOP_NAV: Array<{ id: TopArea; label: string; icon: NavIcon }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'keys', label: 'API keys', icon: KeyRound },
];

const PROJECT_NAV: Array<{ id: string; label: string; icon: NavIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'data', label: 'Keywords & Rankings', icon: LineChart },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
  { id: 'content', label: 'Content Studio', icon: PenSquare },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'publications', label: 'Publications', icon: Newspaper },
  { id: 'publishing', label: 'Publishing', icon: Send },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/**
 * Top-level component.
 *
 * Keeps route + identity state, subscribes to Supabase auth changes, and
 * renders one of: a boot error (Supabase not configured), the auth screen, a
 * loading card, first-project creation, the project workspace, or an
 * account-level area. Project membership comes from `/me`; the role of the
 * active project is passed down so views can gate capabilities per route.
 */
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

  // Re-runs whenever `authed` flips so a freshly signed-in user is loaded into
  // /me without a page reload; guards against stale state after sign-out.
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
        } catch (e) {
          setBootError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
  }, [authed]);

  // Keep the UI's auth state in sync with Supabase token refresh/session
  // changes (e.g. sign-out elsewhere), rather than only at boot.
  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s?.user ? { email: s.user.email ?? null } : null);
      setAuthed(Boolean(s?.user));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const goArea = (area: TopArea) => {
    const r: Route = { area };
    window.history.pushState({}, '', routePath(r));
    setRoute(r);
  };

  const goProject = (projectId: string, view: string) => {
    const r: Route = { area: 'project', projectId, view };
    window.history.pushState({}, '', routePath(r));
    setRoute(r);
  };

  const refreshMe = async () => {
    try {
      const m = await api<Me>('/me');
      setMe(m);
    } catch {
      /* keep current list on failure */
    }
  };

  const meEmail = me?.email ?? session?.email ?? null;

  if (bootError && authed === false) {
    return (
      <CenteredCard>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">SEO Operating Platform</CardTitle>
            <CardDescription>
              Configure Supabase keys, then reload. The API server must be running on :3001 for /api calls.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {bootError}
            </div>
          </CardContent>
        </Card>
      </CenteredCard>
    );
  }

  if (authed === false) {
    return <AuthScreen />;
  }

  if (authed === null || !me) {
    return (
      <CenteredCard>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </CardTitle>
          </CardHeader>
          {bootError && (
            <CardContent>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {bootError}
              </div>
            </CardContent>
          )}
        </Card>
      </CenteredCard>
    );
  }

  const hasProjects = me.projects.length > 0;
  if (!hasProjects) {
    return (
      <CreateProject
        email={meEmail}
        onCreated={(id) => {
          goProject(id, 'dashboard');
          void refreshMe();
        }}
      />
    );
  }

  const activeTop: TopArea | null = route.area === 'project' ? 'projects' : route.area;

  if (route.area === 'project') {
    const project = me.projects.find((p) => p.id === route.projectId) ?? null;
    if (!project) {
      return (
        <div className="flex min-h-screen flex-col">
          <AppHeader
            meEmail={meEmail}
            onSignOut={() => void signOut()}
            active={activeTop}
            onArea={goArea}
            projects={me.projects}
            currentProjectId={null}
            onOpenProject={goProject}
          />
          <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Project not found</CardTitle>
                <CardDescription>This project is not in your account, or you no longer have access to it.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" onClick={() => goArea('projects')}>
                  Back to projects
                </Button>
              </CardContent>
            </Card>
          </main>
        </div>
      );
    }
    const pid = project.id;
    const view = route.view;
    return (
      <div className="flex min-h-screen flex-col">
        <AppHeader
          meEmail={meEmail}
          onSignOut={() => void signOut()}
          active={activeTop}
          onArea={goArea}
          projects={me.projects}
          currentProjectId={pid}
          onOpenProject={goProject}
        />
        <div className="flex flex-1">
          <ProjectSidebar projectId={pid} view={view} onNavigate={goProject} />
          <main className="min-w-0 flex-1 px-6 py-6">
            {view === 'dashboard' && <Dashboard projectId={pid} onOpenSettings={() => goProject(pid, 'settings')} />}
            {view === 'data' && <DataViews projectId={pid} />}
            {view === 'integrations' && <Integrations projectId={pid} />}
            {view === 'knowledge' && <Knowledge projectId={pid} role={project.role} />}
            {view === 'content' && <Content projectId={pid} role={project.role} onOpenCalendar={() => goProject(pid, 'calendar')} onOpenPublications={(contentId) => openProjectView(pid, 'publications', { content_id: contentId })} />}
            {view === 'calendar' && <ContentSchedule projectId={pid} role={project.role} onViewPublication={(scheduleId) => openProjectView(pid, 'publications', { schedule_id: scheduleId })} />}
            {view === 'publications' && <Publications projectId={pid} />}
            {view === 'publishing' && <Publishing projectId={pid} />}
            {view === 'settings' && <ProjectSettings projectId={pid} />}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        meEmail={meEmail}
        onSignOut={() => void signOut()}
        active={activeTop}
        onArea={goArea}
        projects={me.projects}
        currentProjectId={null}
        onOpenProject={goProject}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
        {route.area === 'overview' && <Overview onOpenProject={goProject} onGoProjects={() => goArea('projects')} />}
        {route.area === 'projects' && <ProjectsPage onOpenProject={goProject} />}
        {route.area === 'integrations' && <AccountIntegrations onOpenProject={goProject} />}
        {route.area === 'keys' && <AccountApiKeys />}
      </main>
    </div>
  );
}

/** Sign out of Supabase and hard-reload to the unauthenticated screen. */
async function signOut() {
  await supabase?.auth.signOut();
  window.location.href = '/';
}

/** Center a narrow card in the viewport for boot/loading/error screens. */
function CenteredCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-md px-4 py-16', className)}>{children}</div>;
}

/**
 * Account-level navigation bar shown above every screen. Switches between
 * account areas, shows the current user, and offers a project switcher that
 * routes straight into any project the user belongs to (via onOpenProject).
 */
function AppHeader({
  meEmail,
  onSignOut,
  active,
  onArea,
  projects,
  currentProjectId,
  onOpenProject,
}: {
  meEmail: string | null;
  onSignOut: () => void;
  active: TopArea | null;
  onArea: (area: TopArea) => void;
  projects: ProjectRow[];
  currentProjectId: string | null;
  onOpenProject: (id: string, view: string) => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
      <button
        type="button"
        onClick={() => onArea('overview')}
        className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold tracking-tight text-foreground"
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LineChart className="size-4" />
        </span>
        <span className="hidden sm:inline">SEO Ops</span>
      </button>
      <nav className="ml-1 flex items-center gap-0.5">
        {TOP_NAV.map((n) => {
          const Icon = n.icon;
          const isActive = active === n.id;
          return (
            <Button
              key={n.id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onArea(n.id)}
              className={cn('gap-1.5 text-muted-foreground', isActive && 'bg-secondary text-foreground')}
            >
              <Icon className="size-4" />
              <span className="hidden md:inline">{n.label}</span>
            </Button>
          );
        })}
      </nav>
      {projects.length > 0 && (
        <select
          className="ml-1 h-8 max-w-[180px] rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={currentProjectId ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            if (id) onOpenProject(id, 'dashboard');
          }}
        >
          <option value="" disabled>
            {currentProjectId ? 'Open another project…' : 'Open project…'}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.role})
            </option>
          ))}
        </select>
      )}
      <div className="flex-1" />
      <span className="hidden text-sm text-muted-foreground lg:inline">{meEmail}</span>
      <Button type="button" variant="outline" size="sm" onClick={onSignOut}>
        Sign out
      </Button>
    </header>
  );
}

/** Project workspace sidebar: one entry per project view, icon + label. */
function ProjectSidebar({
  projectId,
  view,
  onNavigate,
}: {
  projectId: string;
  view: string;
  onNavigate: (id: string, view: string) => void;
}) {
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-sidebar md:block">
      <nav className="flex flex-col gap-0.5 p-3">
        {PROJECT_NAV.map((n) => {
          const Icon = n.icon;
          const isActive = view === n.id;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onNavigate(projectId, n.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {n.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * First-run flow shown when the signed-in user has no project yet. Creates a
 * project through the `seo_create_project` RPC (RLS-scoped to the user) and
 * hands the new id to `onCreated` so the app opens its dashboard. Project
 * creation is a Supabase RPC, not an /api call, because it must mint the
 * membership row for the caller in the same transaction.
 */
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
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-2 border-b bg-background px-4">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LineChart className="size-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">SEO Ops</span>
        <div className="flex-1" />
        <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      <CenteredCard className="max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create your first project</CardTitle>
            <CardDescription>
              A project is your isolated SEO workspace: provider connections, tracked keywords, rankings and content
              live here. Search Console connects once at the account level and each project attaches its own property.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="project-name">
                Project name
              </label>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme marketing site" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="project-url">
                Website URL (optional)
              </label>
              <Input id="project-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="project-desc">
                Description (optional)
              </label>
              <Input id="project-desc" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            {err && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {err}
              </div>
            )}
            <div>
              <Button type="button" onClick={() => void create()} disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </CenteredCard>
    </div>
  );
}

/**
 * Supabase email/password auth screen, with magic-link / one-time-code and
 * sign-up flows. Only rendered while `authed === false`; once a session exists
 * App re-bootstraps and loads /me. No provider or service credentials are ever
 * involved here - this is purely identity for the anon-key client.
 */
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
    <CenteredCard>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SEO Operating Platform</CardTitle>
          <CardDescription>
            Modular SEO platform: Search Console data, SERP tracking, keyword research and publishing in one workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!supabaseConfigured && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
            </div>
          )}
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="auth-email">
              Email
            </label>
            <Input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {mode !== 'code' && (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="auth-password">
                Password
              </label>
              <Input id="auth-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          {mode === 'code' && (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="auth-code">
                One-time code
              </label>
              <Input id="auth-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          )}
          {err && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {err}
            </div>
          )}
          {info && (
            <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{info}</div>
          )}
          <div className="flex flex-wrap gap-2">
            {mode !== 'code' ? (
              <Button type="button" onClick={() => void submit()} disabled={busy || !email || !password}>
                {busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
              </Button>
            ) : (
              <Button type="button" onClick={() => void submit()} disabled={busy || !code.trim()}>
                {busy ? '…' : 'Verify code'}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
              {mode === 'login' ? 'Create account instead' : 'Log in instead'}
            </Button>
            {mode === 'code' && (
              <Button type="button" variant="outline" onClick={() => void magic()} disabled={busy || !email}>
                Re-send code
              </Button>
            )}
          </div>
          {mode !== 'code' && (
            <div>
              <Button type="button" variant="ghost" onClick={() => void magic()} disabled={busy || !email}>
                Email me a magic link instead
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </CenteredCard>
  );
}

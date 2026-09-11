/**
 * Projects page (top nav "Projects").
 *
 * Lists the projects the signed-in user belongs to (with their role) and hosts
 * the create-project flow. Each project is an isolated SEO workspace; opening
 * one routes to `/p/:id/dashboard`. Creation goes through the Supabase RPC
 * `seo_create_project` so the membership row is minted RLS-side for the caller.
 */
import { useState } from 'react';
import { useAsync, fmtNum, fmtDate } from '../lib/ui';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

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

/**
 * Renders the project cards and the "New project" form. `onOpenProject`
 * navigates into a chosen project; a fresh project is created through the RPC
 * and opened immediately.
 */
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

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  const projects = data?.projects ?? [];

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Projects"
        description="Isolated SEO workspaces: keywords, rankings, content and publishing live per project."
        actions={
          <Button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Cancel' : 'New project'}</Button>
        }
      />

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Create a project</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="np-name">
                Project name
              </label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme marketing site" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="np-url">
                Website URL (optional)
              </label>
              <Input id="np-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </div>
            {err && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {err}
              </div>
            )}
            <div>
              <Button onClick={() => void create()} disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {projects.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No projects yet. Create one to start tracking keywords, rankings and content.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} className="flex flex-col">
              <CardHeader>
                {p.property ? (
                  <Badge variant="success" className="max-w-full truncate">
                    {p.property.site_url}
                  </Badge>
                ) : (
                  <Badge variant="outline">no GSC property</Badge>
                )}
                <CardTitle className="text-base">{p.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  {p.website_url ?? 'No website set'} · {p.role}
                </p>
                <p className="text-xs text-muted-foreground">
                  {fmtNum(p.integration_count)} integrations · {fmtNum(p.connected_count)} connected ·{' '}
                  {fmtNum(p.content_count)} content · created {fmtDate(p.created_at)}
                </p>
                <div className="mt-auto flex gap-2">
                  <Button size="sm" onClick={() => onOpenProject(p.id, 'dashboard')}>
                    Open
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onOpenProject(p.id, 'settings')}>
                    Settings
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Project settings (project nav "Settings").
 *
 * Owns the per-project Google Search Console property: which property this
 * project pulls data from. The GSC *connection* is account-level (see the
 * account Integrations/Overview views); this screen only attaches or unlinks a
 * property from the account registry, or discovers fresh Google properties to
 * register. Status is always the real server state - connecting/connected/
 * error are rendered from the API, not optimistically.
 */
import { useState } from 'react';
import { useAsync, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface GscConnection {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  last_sync_at: string | null;
  error: string | null;
}

interface Candidate {
  id: string;
  site_url: string;
  permission_level: string | null;
  linked_project: { id: string; name: string } | null;
}

interface StateDto {
  google: GscConnection;
  current: { property_id: string; site_url: string; is_primary: boolean } | null;
  candidates: Candidate[];
}

interface Discovered {
  siteUrl: string;
  permissionLevel: string;
  already_registered: boolean;
}

/**
 * GSC property attach/unlink screen for one project. `projectId` scopes all
 * reads/mutations; if the account is not connected yet it offers the
 * account-level OAuth connect instead.
 */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const state = useAsync<StateDto>(() => api(`/projects/${projectId}/gsc/state`), [projectId]);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (state.loading && !state.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (state.error)
    return <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{state.error}</div>;
  if (!state.data) return null;

  const connected = state.data.google.connected;

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      if (success) setOk(success);
      state.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy('discover');
    setErr(null);
    try {
      const r = await api<{ properties: Discovered[] }>('/account/gsc/discover');
      setDiscovered(r.properties);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const current = state.data.current;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Project settings"
        description="Manage this project's Google Search Console property. The Google connection itself is owned by your account."
      />
      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Google Search Console</CardTitle>
        </CardHeader>
        <CardContent>
          {!connected ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                {state.data.google.status === 'connecting'
                  ? 'Waiting for Google authorization…'
                  : 'This project has no Search Console connection. Connecting authorizes your account (once) so any project can attach its properties.'}
              </p>
              {state.data.google.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {state.data.google.error}
                </div>
              )}
              <div>
                <Button onClick={() => void run('connect', connectGoogle, 'Redirecting to Google…')} disabled={busy !== null}>
                  {busy === 'connect' ? 'Redirecting to Google…' : 'Connect Google Account'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                Account connected. <StatusPill status="connected" />
              </p>
              {current ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Attached property</div>
                    <div className="font-mono text-[15px]">{current.site_url}</div>
                    <div className="text-xs text-muted-foreground">
                      Dashboard and Search Console sync use this property.
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        'unlink',
                        () => api(`/projects/${projectId}/gsc/attach`, { method: 'DELETE', body: {} }),
                        'Property unlinked.',
                      )
                    }
                  >
                    {busy === 'unlink' ? 'Unlinking…' : 'Unlink property'}
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
                  This project has no Google Search Console property connected. Attach one below to start pulling data.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {connected && (
        <>
          {state.data.candidates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Attach a property</CardTitle>
                {current && <p className="text-sm text-muted-foreground">Switching replaces the current property for this project.</p>}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Property</TableHead>
                      <TableHead>Permission</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.data.candidates.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono">{c.site_url}</TableCell>
                        <TableCell className="text-muted-foreground">{c.permission_level ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void run(
                                'attach',
                                () => api(`/projects/${projectId}/gsc/attach`, { method: 'POST', body: { property_id: c.id } }),
                                `Attached ${c.site_url}.`,
                              )
                            }
                          >
                            {busy === 'attach' ? 'Attaching…' : 'Attach'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Add a property from Google</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                Load the Search Console properties your Google account can access, then attach one to this project.
              </p>
              <div>
                <Button variant="outline" onClick={() => void discover()} disabled={busy !== null}>
                  {busy === 'discover' ? 'Loading properties…' : 'Load properties from Google'}
                </Button>
              </div>
              {discovered && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Property</TableHead>
                      <TableHead>Permission</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {discovered.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-muted-foreground">
                          No Search Console properties found for this Google account.
                        </TableCell>
                      </TableRow>
                    )}
                    {discovered.map((d) => {
                      const isCurrent = current?.site_url === d.siteUrl;
                      return (
                        <TableRow key={d.siteUrl}>
                          <TableCell className="font-mono">{d.siteUrl}</TableCell>
                          <TableCell className="text-muted-foreground">{d.permissionLevel ?? '—'}</TableCell>
                          <TableCell className="text-right">
                            {isCurrent ? (
                              <Badge variant="success">current</Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() =>
                                  void run(
                                    'attach',
                                    () => api(`/projects/${projectId}/gsc/attach`, { method: 'POST', body: { siteUrl: d.siteUrl } }),
                                    `Attached ${d.siteUrl}.`,
                                  )
                                }
                              >
                                {busy === 'attach' ? 'Attaching…' : 'Attach'}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

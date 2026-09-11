/**
 * Account-level Integrations view (top nav "Integrations").
 *
 * Provider connections live on the account, not inside a project: Google
 * Search Console is authorized once here (full-tab OAuth, credentials kept
 * server-side and encrypted) and any project can then attach one of the
 * resulting properties; AI/BYOK keys for writing features are also stored here
 * per account, encrypted, and are never sent back to the browser after setup.
 * This view also lists the property registry the account can attach to
 * projects.
 */
import { useState } from 'react';
import { useAsync, fmtDate, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface GscConnection {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  last_sync_at: string | null;
  error: string | null;
}

interface AccountDto {
  account: { id: string; name: string; created_at: string };
  google: GscConnection;
  registry_count: number;
  attached_projects: number;
  projects: Array<{ id: string; name: string; role: string }>;
}

interface RegistryProperty {
  id: string;
  site_url: string;
  permission_level: string | null;
  verified_at: string | null;
  is_active: boolean;
  linked_project: { id: string; name: string } | null;
}

interface AiProviderStatus {
  id: string;
  name: string;
  description: string | null;
  configured: boolean;
  capabilities: string[];
  error: string | null;
}

/**
 * Manages the account's GSC connection, the account-scoped AI BYOK keys and
 * the property registry. Prop `onOpenProject` deep-links an unattached
 * property into a project's Settings view so it can be attached. "Not
 * configured" AI providers are reported as such rather than hidden or faked.
 */
export function AccountIntegrations({ onOpenProject }: { onOpenProject: (id: string, view: string) => void }) {
  const account = useAsync<AccountDto>(() => api('/account'), []);
  const registry = useAsync<{ properties: RegistryProperty[] }>(() => api('/account/gsc/registry'), [account.data?.google.connected]);
  const ai = useAsync<{ providers: AiProviderStatus[] }>(() => api('/account/ai'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiKeyProvider, setAiKeyProvider] = useState<string | null>(null);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiErr, setAiErr] = useState<string | null>(null);

  if (account.loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (account.error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {account.error}
      </div>
    );
  }
  const g = account.data!.google;

  const disconnect = async () => {
    if (!window.confirm('Disconnect Google Search Console? Projects will stop syncing until you reconnect.')) return;
    setBusy('disconnect');
    setErr(null);
    try {
      await api('/account/gsc/disconnect', { method: 'POST', body: {} });
      registry.reload();
      account.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy('connect');
    setErr(null);
    try {
      await connectGoogle();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const saveAiKey = async (providerId: string) => {
    setAiErr(null);
    try {
      await api('/account/ai/key', { method: 'PUT', body: { provider: providerId, apiKey: aiKeyInput.trim() } });
      setAiKeyInput('');
      setAiKeyProvider(null);
      ai.reload();
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAiKey = async (providerId: string) => {
    if (!window.confirm('Remove this AI API key? Projects in this account will stop using AI until you add a key again.')) return;
    setAiErr(null);
    try {
      await api(`/account/ai/key?provider=${encodeURIComponent(providerId)}`, { method: 'DELETE' });
      ai.reload();
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Integrations"
        description="Provider connections live on your account. Credentials stay server-side, encrypted."
      />

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="text-sm font-semibold">Google Search Console</h2>
            <p className="text-sm text-muted-foreground">
              {g.connected
                ? `Connected${g.last_sync_at ? ` · last sync ${fmtDate(g.last_sync_at)}` : ''}`
                : g.status === 'connecting'
                  ? 'Waiting for Google authorization…'
                  : g.status === 'error'
                    ? `Connection error${g.error ? `: ${g.error}` : ''}`
                    : 'Not connected'}
            </p>
            {g.connected && <StatusPill status="connected" />}
            {err && <span className="text-sm text-destructive">{err}</span>}
          </div>
          <div className="flex gap-2">
            {!g.connected ? (
              <Button onClick={() => void connect()} disabled={busy !== null}>
                {busy === 'connect' ? 'Redirecting to Google…' : 'Connect Google Account'}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void disconnect()} disabled={busy !== null}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI &amp; writing</CardTitle>
          <p className="text-sm text-muted-foreground">
            OpenAI powers the in-editor AI actions in Content Studio. The key is stored encrypted on the server and every
            project in this account can use it — it is never shown in the browser.
          </p>
        </CardHeader>
        <CardContent>
          {ai.loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : ai.error ? (
            <span className="text-sm text-destructive">{ai.error}</span>
          ) : (ai.data?.providers.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No AI providers available.</p>
          ) : (
            <div className="divide-y">
              {ai.data!.providers.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="font-medium">{p.name}</div>
                    {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
                    {p.error && <div className="text-xs text-destructive">{p.error}</div>}
                  </div>
                  <Badge variant={p.configured ? 'success' : 'destructive'}>
                    {p.configured ? 'Configured' : 'Not configured'}
                  </Badge>
                  <div className="flex items-center gap-2">
                    {p.configured && aiKeyProvider !== p.id && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setAiKeyProvider(p.id)} disabled={busy !== null}>
                          Update key
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => void removeAiKey(p.id)} disabled={busy !== null}>
                          Remove
                        </Button>
                      </>
                    )}
                    {!p.configured && aiKeyProvider !== p.id && (
                      <Button size="sm" onClick={() => setAiKeyProvider(p.id)} disabled={busy !== null}>
                        Add key
                      </Button>
                    )}
                  </div>
                  {aiKeyProvider === p.id && (
                    <form
                      className="flex w-full flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (aiKeyInput.trim().length >= 8) void saveAiKey(p.id);
                      }}
                    >
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={`${p.name} API key`}
                        value={aiKeyInput}
                        onChange={(e) => setAiKeyInput(e.target.value)}
                        className="min-w-[260px] flex-1"
                      />
                      <Button size="sm" type="submit" disabled={aiKeyInput.trim().length < 8}>
                        Save key
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setAiKeyProvider(null);
                          setAiKeyInput('');
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  )}
                </div>
              ))}
              {aiErr && <div className="pt-2 text-sm text-destructive">{aiErr}</div>}
            </div>
          )}
        </CardContent>
      </Card>

      {g.connected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Property registry <Badge variant="secondary">{account.data?.registry_count ?? 0}</Badge>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              The Google properties this account can use. Attach one to a project from that project's <b>Settings</b>
              {account.data && account.data.attached_projects === 0 && ' — none are used by a project yet.'}
            </p>
          </CardHeader>
          <CardContent>
            {registry.loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (registry.data?.properties.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No properties registered yet. Open a project and attach a property to register it.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Property</TableHead>
                    <TableHead>Permission</TableHead>
                    <TableHead>Used by</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {registry.data!.properties.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-xs">{p.site_url}</TableCell>
                      <TableCell className="text-muted-foreground">{p.permission_level ?? '—'}</TableCell>
                      <TableCell>
                        {p.linked_project ? (
                          <a
                            href="#"
                            className="text-primary hover:underline"
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenProject(p.linked_project!.id, 'settings');
                            }}
                          >
                            {p.linked_project.name}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">unattached</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.linked_project ? (
                          <Button size="sm" variant="outline" onClick={() => onOpenProject(p.linked_project!.id, 'settings')}>
                            Settings
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              account.data!.projects[0] ? onOpenProject(account.data!.projects[0].id, 'settings') : undefined
                            }
                          >
                            Open a project
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

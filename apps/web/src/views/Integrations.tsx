/**
 * Project Integrations view (project nav "Integrations").
 *
 * Catalog-driven: the connectable providers come from the `/providers`
 * catalog endpoint and the UI never hardcodes a vendor. Two setup kinds exist:
 * DataForSEO posts project credentials through the encrypted credentials
 * endpoint (or uses server env when none are given), while GSC runs an OAuth
 * flow and then lets the user pick which property to attach. Secrets leave the
 * browser once during setup and are never returned to it afterwards.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync, StatusPill, Empty } from '../lib/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

interface Descriptor {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  kind: string;
}
interface Catalog {
  dataSources: Descriptor[];
  knowledge: Descriptor[];
  publishers: Descriptor[];
}
interface IntegrationRow {
  integration: Record<string, any>;
  descriptor: Descriptor | null;
}

/**
 * Lists catalog providers to add and renders each existing integration as an
 * IntegrationCard. Props: `projectId` scopes everything; capabilities come
 * from descriptor + stored integration rows. Errors surface through the
 * shared banner pattern with ApiRequestError messages.
 */
export function Integrations({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  const reload = () => setRefresh((x) => x + 1);
  const catalog = useAsync<Catalog>(() => api('/providers'), []);
  const list = useAsync<IntegrationRow[]>(() => api(`/projects/${projectId}/integrations`), [projectId, refresh]);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setNotice(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async (id: string) => {
    await run(async () => {
      await api(`/projects/${projectId}/integrations`, { method: 'POST', body: { provider_type: id } });
    });
  };

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Integrations"
        description="Connections are capability-scoped. Secrets live server-side (encrypted at rest) and are never sent to your browser after setup."
      />

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{notice}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {(catalog.data?.dataSources ?? []).map((d) => (
          <Button key={d.id} onClick={() => void create(d.id)}>
            + Connect {d.name}
          </Button>
        ))}
      </div>

      <div className="grid gap-3">
        {list.loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!list.loading && (list.data ?? []).length === 0 && (
          <Card>
            <CardContent>
              <Empty>No integrations yet. Add one above.</Empty>
            </CardContent>
          </Card>
        )}
        {(list.data ?? []).map(({ integration, descriptor }) => (
          <IntegrationCard
            key={integration.id as string}
            projectId={projectId}
            integration={integration}
            descriptor={descriptor}
            onChanged={reload}
            onError={setErr}
            onNotice={setNotice}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider catalog</CardTitle>
        </CardHeader>
        <CardContent>
          {(catalog.data?.dataSources ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider plugins registered on this server.</p>
          ) : (
            <div className="grid gap-3">
              {(catalog.data?.dataSources ?? []).map((d) => (
                <div key={d.id}>
                  <b>{d.name}</b> <span className="text-muted-foreground">({d.id})</span>
                  <div className="text-xs text-muted-foreground">
                    {d.description} · capabilities: {(d.capabilities ?? []).join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One project integration card. Renders actions by provider kind: DataForSEO
 * gets credential fields + test, GSC gets the OAuth connect / property picker;
 * everyone gets disconnect/delete. Deletes are destructive and are only
 * performed after the API accepts them - the card shows real status pills and
 * never fabricates a connected state.
 */
function IntegrationCard({
  projectId,
  integration,
  descriptor,
  onChanged,
  onError,
}: {
  projectId: string;
  integration: Record<string, any>;
  descriptor: Descriptor | null;
  onChanged: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const id = integration.id as string;
  const type = integration.provider_type as string;
  const connected = integration.status === 'connected';
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreds, setShowCreds] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [gsc, setGsc] = useState<{ props: any[]; picked: string } | null>(null);

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

  const saveCreds = async () => {
    if (!login && !password) return;
    await action('creds', async () => {
      for (const [k, v] of [
        ['dataforseo_login', login],
        ['dataforseo_password', password],
      ] as const) {
        if (v) await api(`/projects/${projectId}/integrations/${id}/credentials`, { method: 'POST', body: { key: k, value: v } });
      }
      setShowCreds(false);
    });
  };

  const oauthUrl = async () => {
    await action('oauth', async () => {
      const r = await api<{ url: string }>(`/projects/${projectId}/integrations/${id}/oauth-url`);
      window.location.href = r.url;
    });
  };

  const loadGscProps = async () => {
    await action('props', async () => {
      const r = await api<{ properties: any[] }>(`/projects/${projectId}/integrations/${id}/gsc/properties`);
      setGsc({ props: r.properties, picked: r.properties[0]?.siteUrl ?? r.properties[0]?.site_url ?? '' });
    });
  };

  const attachProp = async () => {
    if (!gsc?.picked) return;
    await action('attach', async () => {
      await api(`/projects/${projectId}/integrations/${id}/gsc/attach`, {
        method: 'POST',
        body: { siteUrl: gsc.picked },
      });
      setGsc(null);
    });
  };

  return (
    <Card>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <b className="min-w-[130px]">{descriptor?.name ?? type}</b>
          <StatusPill status={integration.status} />
          <span className="font-mono text-xs text-muted-foreground">{type}</span>
          <Badge variant="outline">{integration.config?.site_url ?? 'no property'}</Badge>
          <span className="flex-1" />
          {busy && <Badge variant="warning">{busy}…</Badge>}
        </div>
        {descriptor && (
          <div className="text-xs text-muted-foreground">{(descriptor.capabilities ?? []).join(' · ')}</div>
        )}

        <div className="flex flex-wrap gap-2">
          {type === 'dataforseo' && (
            <>
              {!connected && (
                <Button
                  disabled={busy !== null}
                  onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}
                >
                  Connect (server credentials)
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowCreds((s) => !s)}>
                {showCreds ? 'Hide project credentials' : 'Project credentials'}
              </Button>
              {connected && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}
                >
                  Re-test
                </Button>
              )}
            </>
          )}
          {type === 'gsc' && (
            <>
              {!connected ? (
                <Button disabled={busy !== null} onClick={() => void oauthUrl()}>
                  Connect with Google
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void loadGscProps()}>
                    Choose property
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}
                  >
                    Re-test
                  </Button>
                </>
              )}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void action('disc', () => api(`/projects/${projectId}/integrations/${id}/disconnect`, { method: 'POST' }))}
          >
            Disconnect
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={busy !== null}
            onClick={() => void action('del', () => api(`/projects/${projectId}/integrations/${id}`, { method: 'DELETE' }))}
          >
            Delete
          </Button>
        </div>

        {showCreds && type === 'dataforseo' && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor={`login-${id}`}>
              DataForSEO login (optional — otherwise server env is used)
            </label>
            <Input id={`login-${id}`} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="you@example.com" />
            <label className="text-sm font-medium" htmlFor={`pw-${id}`}>
              Password
            </label>
            <Input id={`pw-${id}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            <div>
              <Button variant="outline" onClick={() => void saveCreds()} disabled={busy !== null}>
                Save credentials
              </Button>
            </div>
          </div>
        )}

        {gsc && type === 'gsc' && (
          <div className="grid gap-1.5">
            {gsc.props.length === 0 ? (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
                No Search Console properties on this account.
              </div>
            ) : (
              <>
                <label className="text-sm font-medium" htmlFor={`prop-${id}`}>
                  Property
                </label>
                <select
                  id={`prop-${id}`}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={gsc.picked}
                  onChange={(e) => setGsc({ ...gsc, picked: e.target.value })}
                >
                  {gsc.props.map((p) => (
                    <option key={p.siteUrl ?? p.site_url} value={p.siteUrl ?? p.site_url}>
                      {p.siteUrl ?? p.site_url}
                    </option>
                  ))}
                </select>
                <div>
                  <Button onClick={() => void attachProp()} disabled={busy !== null}>
                    Attach property
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

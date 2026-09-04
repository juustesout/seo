import { useState } from 'react';
import { api, ApiRequestError } from '../lib/api';
import { useAsync, StatusPill, Empty } from '../lib/ui';

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
    <div>
      <h1>Integrations</h1>
      <p className="sub">
        Connections are capability-scoped. Secrets live server-side (encrypted at rest) and are never sent to your browser
        after setup.
      </p>
      {err && <div className="banner error">{err}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {(catalog.data?.dataSources ?? []).map((d) => (
          <button key={d.id} className="btn primary" onClick={() => void create(d.id)}>
            + Connect {d.name}
          </button>
        ))}
      </div>

      <div className="card">
        {list.loading && <p className="muted">Loading…</p>}
        {!list.loading && (list.data ?? []).length === 0 && <Empty>No integrations yet. Add one above.</Empty>}
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

      <div className="card mt">
        <h2>Provider catalog</h2>
        {((catalog.data?.dataSources ?? []).length === 0 && (
          <p className="muted">No provider plugins registered on this server.</p>
        )) ||
          (catalog.data?.dataSources ?? []).map((d) => (
            <div key={d.id} style={{ marginBottom: 10 }}>
              <b>{d.name}</b> <span className="muted">({d.id})</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {d.description} · capabilities: {(d.capabilities ?? []).join(', ')}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  projectId,
  integration,
  descriptor,
  onChanged,
  onError,
  onNotice,
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
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <b style={{ minWidth: 130 }}>{descriptor?.name ?? type}</b>
        <StatusPill status={integration.status} />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {type}
        </span>
        <span className="pill">{integration.config?.site_url ?? 'no property'}</span>
        <span style={{ flex: 1 }} />
        {busy && <span className="pill busy">{busy}…</span>}
      </div>
      {descriptor && (
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          {(descriptor.capabilities ?? []).join(' · ')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {type === 'dataforseo' && (
          <>
            {!connected && (
              <button className="btn primary" disabled={busy !== null} onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}>
                Connect (server credentials)
              </button>
            )}
            <button className="btn sm" onClick={() => setShowCreds((s) => !s)}>
              {showCreds ? 'Hide project credentials' : 'Project credentials'}
            </button>
            {connected && (
              <button className="btn sm" disabled={busy !== null} onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}>
                Re-test
              </button>
            )}
          </>
        )}
        {type === 'gsc' && (
          <>
            {!connected ? (
              <button className="btn primary" disabled={busy !== null} onClick={() => void oauthUrl()}>
                Connect with Google
              </button>
            ) : (
              <>
                <button className="btn sm" disabled={busy !== null} onClick={() => void loadGscProps()}>
                  Choose property
                </button>
                <button className="btn sm" disabled={busy !== null} onClick={() => void action('test', () => api(`/projects/${projectId}/integrations/${id}/test`, { method: 'POST' }))}>
                  Re-test
                </button>
              </>
            )}
          </>
        )}
        <button className="btn sm" disabled={busy !== null} onClick={() => void action('disc', () => api(`/projects/${projectId}/integrations/${id}/disconnect`, { method: 'POST' }))}>
          Disconnect
        </button>
        <button className="btn sm danger" disabled={busy !== null} onClick={() => void action('del', () => api(`/projects/${projectId}/integrations/${id}`, { method: 'DELETE' }))}>
          Delete
        </button>
      </div>

      {showCreds && type === 'dataforseo' && (
        <div className="mt">
          <label className="fld">DataForSEO login (optional — otherwise server env is used)</label>
          <input type="text" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="you@example.com" />
          <label className="fld">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          <div className="mt">
            <button className="btn" onClick={() => void saveCreds()} disabled={busy !== null}>
              Save credentials
            </button>
          </div>
        </div>
      )}

      {gsc && type === 'gsc' && (
        <div className="mt">
          {gsc.props.length === 0 ? (
            <div className="banner">No Search Console properties on this account.</div>
          ) : (
            <>
              <label className="fld">Property</label>
              <select value={gsc.picked} onChange={(e) => setGsc({ ...gsc, picked: e.target.value })}>
                {gsc.props.map((p) => (
                  <option key={p.siteUrl ?? p.site_url} value={p.siteUrl ?? p.site_url}>
                    {p.siteUrl ?? p.site_url}
                  </option>
                ))}
              </select>
              <div className="mt">
                <button className="btn primary" onClick={() => void attachProp()} disabled={busy !== null}>
                  Attach property
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

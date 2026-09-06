import { useState } from 'react';
import { useAsync, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';

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

export function ProjectSettings({ projectId }: { projectId: string }) {
  const state = useAsync<StateDto>(() => api(`/projects/${projectId}/gsc/state`), [projectId]);
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (state.loading && !state.data) return <p className="muted">Loading…</p>;
  if (state.error) return <div className="banner error">{state.error}</div>;
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
    <div>
      <h1>Project settings</h1>
      <p className="sub">Manage this project's Google Search Console property. The Google connection itself is owned by your account.</p>
      {err && <div className="banner error">{err}</div>}
      {ok && <div className="banner ok">{ok}</div>}

      <div className="card">
        <h2>Google Search Console</h2>
        {!connected ? (
          <div>
            <p className="sub">
              {state.data.google.status === 'connecting'
                ? 'Waiting for Google authorization…'
                : 'This project has no Search Console connection. Connecting authorizes your account (once) so any project can attach its properties.'}
            </p>
            {state.data.google.error && <div className="banner error">{state.data.google.error}</div>}
            <button className="btn primary" onClick={() => void run('connect', connectGoogle, 'Redirecting to Google…')} disabled={busy !== null}>
              {busy === 'connect' ? 'Redirecting to Google…' : 'Connect Google Account'}
            </button>
          </div>
        ) : (
          <div>
            <p className="sub">
              Account connected. <StatusPill status="connected" />
            </p>
            <div className="mt">
              {current ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div className="label">Attached property</div>
                    <div className="mono" style={{ fontSize: 15 }}>
                      {current.site_url}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Dashboard and Search Console sync use this property.
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => void run('unlink', () => api(`/projects/${projectId}/gsc/attach`, { method: 'DELETE', body: {} }), 'Property unlinked.')}
                  >
                    {busy === 'unlink' ? 'Unlinking…' : 'Unlink property'}
                  </button>
                </div>
              ) : (
                <div className="banner info">This project has no Google Search Console property connected. Attach one below to start pulling data.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {connected && (
        <>
          {state.data.candidates.length > 0 && (
            <div className="card mt">
              <h2>Attach a property</h2>
              {current && <p className="sub">Switching replaces the current property for this project.</p>}
              <table>
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Permission</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.data.candidates.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.site_url}</td>
                      <td className="muted">{c.permission_level ?? '—'}</td>
                      <td className="num">
                        <button
                          className="btn sm primary"
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
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card mt">
            <h2>Add a property from Google</h2>
            <p className="sub">Load the Search Console properties your Google account can access, then attach one to this project.</p>
            <button className="btn" onClick={() => void discover()} disabled={busy !== null}>
              {busy === 'discover' ? 'Loading properties…' : 'Load properties from Google'}
            </button>
            {discovered && (
              <table className="mt">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Permission</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {discovered.length === 0 && (
                    <tr>
                      <td colSpan={3} className="muted">
                        No Search Console properties found for this Google account.
                      </td>
                    </tr>
                  )}
                  {discovered.map((d) => {
                    const isCurrent = current?.site_url === d.siteUrl;
                    return (
                      <tr key={d.siteUrl}>
                        <td className="mono">{d.siteUrl}</td>
                        <td className="muted">{d.permissionLevel ?? '—'}</td>
                        <td className="num">
                          {isCurrent ? (
                            <span className="pill ok">current</span>
                          ) : (
                            <button
                              className="btn sm"
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
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

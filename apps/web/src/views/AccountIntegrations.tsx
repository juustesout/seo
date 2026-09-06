import { useState } from 'react';
import { useAsync, fmtDate, StatusPill } from '../lib/ui';
import { api } from '../lib/api';
import { connectGoogle } from '../lib/gsc';

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

export function AccountIntegrations({ onOpenProject }: { onOpenProject: (id: string, view: string) => void }) {
  const account = useAsync<AccountDto>(() => api('/account'), []);
  const registry = useAsync<{ properties: RegistryProperty[] }>(() => api('/account/gsc/registry'), [account.data?.google.connected]);
  const ai = useAsync<{ providers: AiProviderStatus[] }>(() => api('/account/ai'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiKeyProvider, setAiKeyProvider] = useState<string | null>(null);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiErr, setAiErr] = useState<string | null>(null);

  if (account.loading) return <p className="muted">Loading…</p>;
  if (account.error) return <div className="banner error">{account.error}</div>;
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
    <div>
      <h1>Integrations</h1>
      <p className="sub">Provider connections live on your account. Credentials stay server-side, encrypted.</p>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Google Search Console</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {g.connected
                ? `Connected${g.last_sync_at ? ` · last sync ${fmtDate(g.last_sync_at)}` : ''}`
                : g.status === 'connecting'
                  ? 'Waiting for Google authorization…'
                  : g.status === 'error'
                    ? `Connection error${g.error ? `: ${g.error}` : ''}`
                    : 'Not connected'}
            </p>
            {g.connected && <div className="mt" style={{ marginTop: 8 }}><StatusPill status="connected" /></div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!g.connected ? (
              <button className="btn primary" onClick={() => void connect()} disabled={busy !== null}>
                {busy === 'connect' ? 'Redirecting to Google…' : 'Connect Google Account'}
              </button>
            ) : (
              <button className="btn" onClick={() => void disconnect()} disabled={busy !== null}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            )}
          </div>
        </div>
        {err && <div className="error-line">{err}</div>}
      </div>

      <div className="card mt">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>AI & writing</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              OpenAI powers the in-editor AI actions in Content Studio. The key is stored encrypted on the server and
              every project in this account can use it — it is never shown in the browser.
            </p>
          </div>
        </div>
        {ai.loading ? (
          <p className="muted">Loading…</p>
        ) : ai.error ? (
          <div className="error-line">{ai.error}</div>
        ) : (ai.data?.providers.length ?? 0) === 0 ? (
          <p className="muted">No AI providers available.</p>
        ) : (
          <div className="mt">
            {ai.data!.providers.map((p) => (
              <div key={p.id} className="ai-row">
                <div style={{ minWidth: 0 }}>
                  <strong>{p.name}</strong>
                  {p.description && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.description}
                    </div>
                  )}
                  {p.error && (
                    <div className="muted" style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>
                      {p.error}
                    </div>
                  )}
                </div>
                <span className={`pill ${p.configured ? 'ok' : 'err'}`}>{p.configured ? 'Configured' : 'Not configured'}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {p.configured && aiKeyProvider !== p.id && (
                    <>
                      <button className="btn sm" onClick={() => setAiKeyProvider(p.id)} disabled={busy !== null}>
                        Update key
                      </button>
                      <button className="btn sm danger" onClick={() => void removeAiKey(p.id)} disabled={busy !== null}>
                        Remove
                      </button>
                    </>
                  )}
                  {!p.configured && aiKeyProvider !== p.id && (
                    <button className="btn sm primary" onClick={() => setAiKeyProvider(p.id)} disabled={busy !== null}>
                      Add key
                    </button>
                  )}
                </div>
                {aiKeyProvider === p.id && (
                  <form
                    className="row mt"
                    style={{ flexBasis: '100%' }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (aiKeyInput.trim().length >= 8) void saveAiKey(p.id);
                    }}
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={`${p.name} API key`}
                      value={aiKeyInput}
                      onChange={(e) => setAiKeyInput(e.target.value)}
                      style={{ minWidth: 260 }}
                    />
                    <button className="btn primary sm" type="submit" disabled={aiKeyInput.trim().length < 8}>
                      Save key
                    </button>
                    <button className="btn sm" type="button" onClick={() => { setAiKeyProvider(null); setAiKeyInput(''); }}>
                      Cancel
                    </button>
                  </form>
                )}
              </div>
            ))}
            {aiErr && <div className="error-line">{aiErr}</div>}
          </div>
        )}
      </div>

      {g.connected && (
        <div className="card mt">
          <h2>
            Property registry{' '}
            <span className="pill">{account.data?.registry_count ?? 0}</span>
          </h2>
          <p className="sub">
            The Google properties this account can use. Attach one to a project from that project's <b>Settings</b>{' '}
            {account.data && account.data.attached_projects === 0 && '— none are used by a project yet.'}
          </p>
          {registry.loading ? (
            <p className="muted">Loading…</p>
          ) : (registry.data?.properties.length ?? 0) === 0 ? (
            <div className="empty">No properties registered yet. Open a project and attach a property to register it.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Permission</th>
                  <th>Used by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {registry.data!.properties.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.site_url}</td>
                    <td className="muted">{p.permission_level ?? '—'}</td>
                    <td>
                      {p.linked_project ? (
                        <a href="#" onClick={(e) => { e.preventDefault(); onOpenProject(p.linked_project!.id, 'settings'); }}>
                          {p.linked_project.name}
                        </a>
                      ) : (
                        <span className="muted">unattached</span>
                      )}
                    </td>
                    <td className="num">
                      {p.linked_project ? (
                        <button className="btn sm" onClick={() => onOpenProject(p.linked_project!.id, 'settings')}>
                          Settings
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => (account.data!.projects[0] ? onOpenProject(account.data!.projects[0].id, 'settings') : undefined)}>
                          Open a project
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useAsync, StatusPill, fmtDate, Empty } from '../lib/ui';
import { api } from '../lib/api';

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ListDto {
  keys: KeyRow[];
  note: string;
}

interface CreatedKey {
  key: string;
  id: string;
  name: string;
  scopes: string[];
  note: string;
}

type Scope = 'read' | 'write';

export function AccountApiKeys() {
  const state = useAsync<ListDto>(() => api('/account/api-keys'), []);
  const [name, setName] = useState('');
  const [sel, setSel] = useState<Scope[]>(['read']);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const toggle = (s: Scope) => setSel((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const create = async () => {
    if (!name.trim()) return;
    setBusy('create');
    setErr(null);
    setOk(null);
    setCopied(false);
    try {
      const r = await api<CreatedKey>('/account/api-keys', { method: 'POST', body: { name: name.trim(), scopes: sel } });
      setCreated(r);
      setName('');
      state.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (row: KeyRow) => {
    setBusy(row.id);
    setErr(null);
    setOk(null);
    try {
      await api(`/account/api-keys/${row.id}/revoke`, { method: 'POST', body: {} });
      setOk(`API key "${row.name}" revoked.`);
      state.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created?.key ?? '');
      setCopied(true);
    } catch {
      /* clipboard unavailable: key is still visible to copy manually */
    }
  };

  return (
    <div>
      <h1>API keys</h1>
      <p className="sub">
        Account (master) keys let an external agent reach every project you are a member of through the REST and MCP APIs. A master key is
        never stronger than your role in the project it touches: reads need your membership, writes need at least editor.
      </p>
      {err && <div className="banner error">{err}</div>}
      {ok && <div className="banner ok">{ok}</div>}

      {created && (
        <div className="banner info">
          <div className="label">{created.name} created — copy this key now, it will not be shown again.</div>
          <div className="mono" style={{ wordBreak: 'break-all', fontSize: 13 }}>
            {created.key}
          </div>
          <button className="btn sm mt" onClick={() => void copy()} disabled={copied}>
            {copied ? 'Copied' : 'Copy key'}
          </button>
        </div>
      )}

      <div className="card">
        <h2>Create a master key</h2>
        <p className="sub">
          Name it after the agent or job it belongs to (for example <span className="mono">hermes-agent</span>) and pick the maximum scopes it
          may use anywhere.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 220px' }}>
            <div className="label">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="hermes-agent"
              maxLength={120}
              disabled={busy !== null}
            />
          </div>
          <div>
            <div className="label">Scopes</div>
            <div style={{ display: 'flex', gap: 14 }}>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={sel.includes('read')} onChange={() => toggle('read')} disabled={busy !== null} /> read
              </label>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={sel.includes('write')} onChange={() => toggle('write')} disabled={busy !== null} /> write
              </label>
            </div>
          </div>
          <button className="btn primary" onClick={() => void create()} disabled={busy !== null || !name.trim()}>
            {busy === 'create' ? 'Creating…' : 'Create key'}
          </button>
        </div>
        <div className="muted mt" style={{ fontSize: 12 }}>
          Key format: <span className="mono">seo_live_…</span>. Only the SHA-256 hash is stored server-side.
        </div>
      </div>

      <div className="card mt">
        <h2>Your master keys</h2>
        {state.loading && !state.data ? (
          <p className="muted">Loading…</p>
        ) : state.error ? (
          <div className="banner error">{state.error}</div>
        ) : !state.data || state.data.keys.length === 0 ? (
          <Empty>No master keys yet. Create one above to connect an agent or CLI.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div>{k.name}</div>
                    <div className="mono muted">{k.key_prefix}…</div>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {k.scopes.map((s) => (
                        <span key={s} className="pill">
                          {s}
                        </span>
                      ))}
                      {k.revoked_at ? <StatusPill status="revoked" /> : <StatusPill status="active" />}
                    </span>
                  </td>
                  <td className="muted">{k.last_used_at ? fmtDate(k.last_used_at) : '—'}</td>
                  <td className="muted">{fmtDate(k.created_at)}</td>
                  <td className="num">
                    {!k.revoked_at && (
                      <button className="btn sm" disabled={busy !== null} onClick={() => void revoke(k)}>
                        {busy === k.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card mt">
        <h2>Where a master key works</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            REST v1: <span className="mono">GET/PATCH /api/v1/projects/:projectId/content…</span> with{' '}
            <span className="mono">Authorization: Bearer seo_live_…</span>
          </li>
          <li>
            MCP over streamable HTTP: <span className="mono">/api/mcp</span> (pass project_id to every tool call)
          </li>
          <li>Read tools require your membership; write tools require editor (or admin/owner). A viewer role is read-only even for a write key.</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Account API keys view (top nav "API keys").
 *
 * Master keys let an external agent (REST or MCP) reach every project the
 * signed-in user is a member of, but a key is never stronger than the user's
 * role in the project it touches. The browser only ever sees a freshly created
 * key once - the server stores only its SHA-256 hash - so after creation the UI
 * just lists the prefix and revoke state. The view is account-scoped and talks
 * only to the `/account/api-keys` endpoints; key material never touches
 * localStorage or logs.
 */
import { useState } from 'react';
import { useAsync, StatusPill, fmtDate, Empty } from '../lib/ui';
import { api } from '../lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

/**
 * Create/revoke master keys and explain where they work. Reads the list via
 * useAsync, posts create/revoke mutations through lib/api.ts and reflects
 * failures as ApiRequestError messages in inline banners.
 */
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
    <div className="grid gap-5">
      <PageHeader
        title="API keys"
        description="Account (master) keys let an external agent reach every project you are a member of through the REST and MCP APIs. A master key is never stronger than your role in the project it touches: reads need your membership, writes need at least editor."
      />

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>
      )}

      {created && (
        <Card className="border-primary/30 bg-accent">
          <CardContent className="grid gap-3">
            <p className="text-sm font-medium text-accent-foreground">
              {created.name} created — copy this key now, it will not be shown again.
            </p>
            <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-xs">
              {created.key}
            </code>
            <div>
              <Button size="sm" variant="outline" onClick={() => void copy()} disabled={copied}>
                {copied ? 'Copied' : 'Copy key'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create a master key</CardTitle>
          <p className="text-sm text-muted-foreground">
            Name it after the agent or job it belongs to (for example{' '}
            <span className="font-mono">hermes-agent</span>) and pick the maximum scopes it may use anywhere.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid min-w-[220px] flex-1 gap-1.5">
              <label className="text-sm font-medium" htmlFor="key-name">
                Name
              </label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="hermes-agent"
                maxLength={120}
                disabled={busy !== null}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Scopes</span>
              <div className="flex items-center gap-4 pb-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={sel.includes('read')}
                    onChange={() => toggle('read')}
                    disabled={busy !== null}
                  />{' '}
                  read
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={sel.includes('write')}
                    onChange={() => toggle('write')}
                    disabled={busy !== null}
                  />{' '}
                  write
                </label>
              </div>
            </div>
            <Button onClick={() => void create()} disabled={busy !== null || !name.trim()}>
              {busy === 'create' ? 'Creating…' : 'Create key'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Key format: <span className="font-mono">seo_live_…</span>. Only the SHA-256 hash is stored server-side.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your master keys</CardTitle>
        </CardHeader>
        <CardContent>
          {state.loading && !state.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : state.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {state.error}
            </div>
          ) : !state.data || state.data.keys.length === 0 ? (
            <Empty>No master keys yet. Create one above to connect an agent or CLI.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div>{k.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{k.key_prefix}…</div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="outline">
                            {s}
                          </Badge>
                        ))}
                        {k.revoked_at ? <StatusPill status="revoked" /> : <StatusPill status="active" />}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{k.last_used_at ? fmtDate(k.last_used_at) : '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(k.created_at)}</TableCell>
                    <TableCell className="text-right">
                      {!k.revoked_at && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void revoke(k)}
                        >
                          {busy === k.id ? 'Revoking…' : 'Revoke'}
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

      <Card>
        <CardHeader>
          <CardTitle>Where a master key works</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
            <li>
              REST v1: <span className="font-mono">GET/PATCH /api/v1/projects/:projectId/content…</span> with{' '}
              <span className="font-mono">Authorization: Bearer seo_live_…</span>
            </li>
            <li>
              MCP over streamable HTTP: <span className="font-mono">/api/mcp</span> (pass project_id to every tool call)
            </li>
            <li>
              Read tools require your membership; write tools require editor (or admin/owner). A viewer role is read-only
              even for a write key.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

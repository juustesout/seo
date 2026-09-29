/**
 * Project Analytics property panel (P4).
 *
 * Lets a project administrator/owner bind the project to one account-level GA4
 * property (and change or clear it). The Google Analytics *connection* is owned
 * by the account (see the account Integrations view); this panel only selects
 * which property this project reads page traffic from. The server re-validates
 * the chosen id against the account's live Google metadata and authorizes the
 * admin role, so this component only decides what to *show*.
 */
import { useState } from 'react';
import { useAsync } from '../../lib/ui';
import {
  connectAnalytics,
  clearAnalyticsProperty,
  projectAnalyticsProperties,
  projectAnalyticsState,
  selectAnalyticsProperty,
  type AnalyticsProperty,
  type AnalyticsState,
} from '../../lib/analytics';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function AnalyticsPropertyPanel({ projectId, role }: { projectId: string; role: string }) {
  const state = useAsync<AnalyticsState>(() => projectAnalyticsState(projectId), [projectId]);
  const [properties, setProperties] = useState<AnalyticsProperty[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canManage = state.data?.can_manage ?? (role === 'owner' || role === 'admin');
  const google = state.data?.google;
  const current = state.data?.current ?? null;

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      if (success) setOk(success);
      state.reload();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy('discover');
    setErr(null);
    setOk(null);
    try {
      const r = await projectAnalyticsProperties(projectId);
      setProperties(r.properties);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const select = async (propertyId: string) => {
    const done = await run('select', () => selectAnalyticsProperty(projectId, propertyId), 'Analytics property updated.');
    if (done) setProperties(null);
  };

  const clear = async () => {
    if (!window.confirm('Remove the Google Analytics property from this project?')) return;
    const done = await run('clear', () => clearAnalyticsProperty(projectId), 'Analytics property removed.');
    if (done) setProperties(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Analytics</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read-only GA4 page traffic for this project. The Google connection is account-level; here you choose which
          property this project reads.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {state.loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{state.error}</div>
        ) : !google?.connected ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Google Analytics isn&apos;t connected. Connect Google Analytics to see page traffic.</p>
            <div>
              <Button
                onClick={() => {
                  void connectAnalytics().catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
                }}
                disabled={busy !== null}
              >
                Connect Google Analytics
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Connected as {google.account_email ?? 'your Google account'}</p>

            {current ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{current.property_name}</div>
                  <div className="truncate text-xs text-muted-foreground">{current.property_url ?? `Property ${current.property_id}`}</div>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => void discover()} disabled={busy !== null}>
                      Change
                    </Button>
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => void clear()} disabled={busy !== null}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Choose a Google Analytics property for this project.</p>
            )}

            {canManage && properties === null && !current && (
              <div>
                <Button onClick={() => void discover()} disabled={busy !== null}>
                  {busy === 'discover' ? 'Loading properties…' : 'Choose property'}
                </Button>
              </div>
            )}

            {properties !== null && (
              <div className="grid gap-2">
                {properties.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No GA4 properties were found for this Google account.</p>
                ) : (
                  properties.map((p) => (
                    <div key={p.property_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <div className="min-w-0">
                        <div className="font-medium">{p.property_name}</div>
                        <div className="truncate text-xs text-muted-foreground">{p.property_url ?? `Property ${p.property_id}`}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => void select(p.property_id)} disabled={busy !== null || current?.property_id === p.property_id}>
                          {current?.property_id === p.property_id ? 'Selected' : 'Select'}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setProperties(null)} disabled={busy !== null}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {ok && <span className="text-sm text-muted-foreground">{ok}</span>}
            {err && <span className="text-sm text-destructive">{err}</span>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

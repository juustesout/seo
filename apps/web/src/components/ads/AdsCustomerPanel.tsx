/**
 * Project Google Ads customer panel (P5).
 *
 * Lets a project administrator/owner bind the project to one account-level
 * Google Ads customer (and change or clear it). The Google Ads *connection* is
 * owned by the account (see the account Integrations view); this panel only
 * selects which customer this project reads paid search intelligence from. The
 * server re-validates the chosen id against the account's live Google metadata
 * and authorizes the admin role, so this component only decides what to *show*.
 */
import { useState } from 'react';
import { useAsync } from '../../lib/ui';
import {
  connectAds,
  clearAdsCustomer,
  projectAdsCustomers,
  projectAdsState,
  selectAdsCustomer,
  type AdsCustomer,
  type AdsState,
} from '../../lib/ads';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** A customer's supporting line: manager flag, currency or id. */
function customerSubtitle(c: AdsCustomer): string {
  const bits: string[] = [];
  if (c.is_manager) bits.push('Manager account');
  if (c.currency_code) bits.push(c.currency_code);
  bits.push(`Customer ${c.customer_id}`);
  return bits.join(' · ');
}

export function AdsCustomerPanel({ projectId, role }: { projectId: string; role: string }) {
  const state = useAsync<AdsState>(() => projectAdsState(projectId), [projectId]);
  const [customers, setCustomers] = useState<AdsCustomer[] | null>(null);
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
      const r = await projectAdsCustomers(projectId);
      setCustomers(r.customers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const select = async (customerId: string) => {
    const done = await run('select', () => selectAdsCustomer(projectId, customerId), 'Google Ads customer updated.');
    if (done) setCustomers(null);
  };

  const clear = async () => {
    if (!window.confirm('Remove the Google Ads customer from this project?')) return;
    const done = await run('clear', () => clearAdsCustomer(projectId), 'Google Ads customer removed.');
    if (done) setCustomers(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Ads</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read-only Google Ads paid search intelligence for this project. The Google connection is account-level; here
          you choose which customer this project reads.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {state.loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{state.error}</div>
        ) : !google?.connected ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Google Ads isn&apos;t connected. Connect Google Ads to see paid search intelligence.</p>
            <div>
              <Button
                onClick={() => {
                  void connectAds().catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
                }}
                disabled={busy !== null}
              >
                Connect Google Ads
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Connected as {google.account_email ?? 'your Google account'}</p>

            {current ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{current.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{customerSubtitle(current)}</div>
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
              <p className="text-sm text-muted-foreground">Choose a Google Ads customer for this project.</p>
            )}

            {canManage && customers === null && !current && (
              <div>
                <Button onClick={() => void discover()} disabled={busy !== null}>
                  {busy === 'discover' ? 'Loading customers…' : 'Choose customer'}
                </Button>
              </div>
            )}

            {customers !== null && (
              <div className="grid gap-2">
                {customers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No Google Ads customers were found for this Google account.</p>
                ) : (
                  customers.map((c) => (
                    <div key={c.customer_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <div className="min-w-0">
                        <div className="font-medium">{c.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{customerSubtitle(c)}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => void select(c.customer_id)} disabled={busy !== null || current?.customer_id === c.customer_id}>
                          {current?.customer_id === c.customer_id ? 'Selected' : 'Select'}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setCustomers(null)} disabled={busy !== null}>
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

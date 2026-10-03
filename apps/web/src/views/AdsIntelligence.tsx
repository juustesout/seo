/**
 * Paid search view (P5, project nav "Paid search").
 *
 * A compact read of "which search terms and keywords actually receive paid
 * traffic?" from the project's bound Google Ads customer. It is deliberately
 * not a Google Ads replacement: two tables, one period, an optional text
 * filter, and honest states (not connected / no customer / no data / error).
 * Search terms (what users typed) and keywords (what the advertiser bid on) are
 * kept as separate tables because they answer different questions. All Google
 * specifics stay server-side; this view only renders the normalized report.
 */
import { useState } from 'react';
import { fmtNum, useAsync } from '../lib/ui';
import { adsReport, type AdsReport } from '../lib/ads';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { DEFAULT_PERIOD_DAYS, PeriodSelector } from '@/components/ui/period-selector';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Currency amount with the customer's ISO code when Google reports one. */
function fmtCost(v: unknown, currency: string | null): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return `${currency ? `${currency} ` : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Click-through rate as a percentage (0.0342 -> "3.42%"). */
function fmtPct(v: unknown): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return `${(n * 100).toFixed(2)}%`;
}

export function AdsIntelligence({ projectId, onOpenSettings }: { projectId: string; onOpenSettings?: () => void }) {
  const [days, setDays] = useState(DEFAULT_PERIOD_DAYS);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const report = useAsync<AdsReport>(() => adsReport(projectId, days, filter || undefined), [projectId, days, filter]);

  const data = report.data;
  const currency = data?.customer?.currency_code ?? null;

  return (
    <div className="grid gap-5">
      <PageHeader title="Paid search" description="Search terms and keywords receiving paid traffic, from Google Ads." />

      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelector value={days} onChange={setDays} />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(filterInput.trim());
          }}
        >
          <Input
            placeholder="Filter by text"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            className="w-48"
          />
          <Button size="sm" type="submit" variant="outline">
            Apply
          </Button>
          {filter && (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setFilterInput('');
                setFilter('');
              }}
            >
              Clear
            </Button>
          )}
        </form>
      </div>

      {data?.customer && (
        <p className="text-sm text-muted-foreground">
          {data.customer.name}
          {currency ? ` · ${currency}` : ''}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Search terms</CardTitle>
          <p className="text-sm text-muted-foreground">What users actually typed into Google before clicking an ad.</p>
        </CardHeader>
        <CardContent>
          {report.loading ? (
            <p className="text-sm text-muted-foreground">Loading paid search…</p>
          ) : report.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{report.error}</div>
          ) : !data?.customer ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">Choose a Google Ads customer for this project.</p>
              {onOpenSettings && (
                <div>
                  <Button size="sm" variant="outline" onClick={onOpenSettings}>
                    Open project settings
                  </Button>
                </div>
              )}
            </div>
          ) : data.search_terms.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No search terms were recorded for this period.</p>
          ) : (
            <div className="grid gap-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Search term</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Impressions</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Conversions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.search_terms.map((r) => (
                    <TableRow key={r.search_term}>
                      <TableCell className="font-medium">{r.search_term}</TableCell>
                      <TableCell className="text-muted-foreground">{r.status ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.impressions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(r.ctr)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtCost(r.cost, currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.conversions)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.search_terms_truncated && (
                <p className="text-xs text-muted-foreground">Showing the top {fmtNum(data.limit)} search terms by impressions.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {data?.customer && (
        <Card>
          <CardHeader>
            <CardTitle>Keywords</CardTitle>
            <p className="text-sm text-muted-foreground">The keywords you bid on and how they performed.</p>
          </CardHeader>
          <CardContent>
            {data.keywords.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No keywords were recorded for this period.</p>
            ) : (
              <div className="grid gap-2">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="text-right">Impressions</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">CTR</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Conversions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.keywords.map((r, i) => (
                      <TableRow key={`${r.keyword_text}-${r.match_type}-${r.ad_group_name ?? ''}-${i}`}>
                        <TableCell className="font-medium">{r.keyword_text}</TableCell>
                        <TableCell className="text-muted-foreground">{r.match_type}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.campaign_name ?? '—'}
                          {r.ad_group_name ? ` / ${r.ad_group_name}` : ''}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPct(r.ctr)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCost(r.cost, currency)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.conversions)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {data.keywords_truncated && (
                  <p className="text-xs text-muted-foreground">Showing the top {fmtNum(data.limit)} keywords by impressions.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Keywords view: the queries Google Search Console reports for this project's
 * linked property, and how they perform.
 *
 * This is a pure read of already-synced GSC data through
 * `/projects/:id/gsc/keywords` - it never talks to Google, never triggers a
 * sync and never fabricates research metrics. Three honest states are rendered
 * from the API payload: no property linked (connect prompt), property linked
 * but nothing synced yet (run-a-sync prompt), and aggregated query data.
 */
import { useAsync, num, fmtNum, fmtDate } from '../lib/ui';
import { api } from '../lib/api';
import type { KeywordDto, ProjectKeywordsDto } from '@seo/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** CTR is a 0..1 fraction from GSC; render it as a percentage. */
function fmtCtr(v: unknown): string {
  return `${(num(v) * 100).toFixed(2)}%`;
}

/** Weighted average position, limited to one decimal for readability. */
function fmtPosition(v: unknown): string {
  return num(v).toFixed(1);
}

function KeywordTable({ keywords }: { keywords: KeywordDto[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Query</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
          <TableHead className="text-right">Impressions</TableHead>
          <TableHead className="text-right">CTR</TableHead>
          <TableHead className="text-right">Position</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keywords.map((k) => (
          <TableRow key={k.keyword}>
            <TableCell className="max-w-[28rem] truncate font-medium" title={k.keyword}>
              {k.keyword}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(k.clicks)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(k.impressions)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtCtr(k.ctr)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtPosition(k.position)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Keywords({ projectId }: { projectId: string }) {
  const { data, error, loading } = useAsync<ProjectKeywordsDto>(
    () => api(`/projects/${projectId}/gsc/keywords`),
    [projectId],
  );

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Keywords"
        description="Queries your site is seen for in Google Search Console, and how they perform over the last 28 days."
      />

      {loading && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Loading keywords…</CardContent>
        </Card>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not load keyword data. Please try again.
        </div>
      )}

      {!loading && !error && data && (
        <Card>
          <CardContent>
            {!data.propertyId && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Google Search Console is not connected to this project.
              </div>
            )}

            {data.propertyId && data.keywords.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No keyword data is available yet. Run a Google Search Console sync first.
              </div>
            )}

            {data.propertyId && data.keywords.length > 0 && (
              <>
                {data.lastSyncedAt && (
                  <p className="mb-3 text-xs text-muted-foreground">Last synced {fmtDate(data.lastSyncedAt)}</p>
                )}
                <KeywordTable keywords={data.keywords} />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

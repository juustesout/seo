/**
 * Unified Google hub (P6a).
 *
 * Search Console, Analytics and Ads used to be three unrelated entries in the
 * project navigation. This view is the single front door: one card per product
 * that states, honestly and without raw OAuth/API error text, whether the
 * account is connected, whether this project has chosen a property/customer,
 * and the one next action to take. Each product is authorized separately, so a
 * failure or disconnection in one product never hides the others. The detailed
 * views stay where they are and keep the shared period selector.
 */
import { useAsync } from '../lib/ui';
import { projectGscState, connectGoogle } from '../lib/gsc';
import { projectAnalyticsState, connectAnalytics } from '../lib/analytics';
import { projectAdsState, connectAds } from '../lib/ads';
import { GOOGLE_STATE_LABEL, googleProductState, type GoogleProductState } from '../lib/googleStatus';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';

const STATE_VARIANT: Record<GoogleProductState, 'success' | 'warning' | 'outline'> = {
  connected: 'success',
  needs_configuration: 'warning',
  needs_attention: 'warning',
  not_connected: 'outline',
};

function GoogleProductCard({
  title,
  description,
  state,
  detail,
  error,
  canManage,
  openLabel,
  connectLabel,
  onConnect,
  onConfigure,
  onOpen,
  onRetry,
}: {
  title: string;
  description: string;
  state: GoogleProductState | null;
  detail: string | null;
  error?: string | null;
  canManage: boolean;
  openLabel: string;
  connectLabel: string;
  onConnect: () => void;
  onConfigure: () => void;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const resolved = state ?? 'not_connected';
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {error ? (
            <Badge variant="warning">Could not load</Badge>
          ) : (
            state && <Badge variant={STATE_VARIANT[resolved]}>{GOOGLE_STATE_LABEL[resolved]}</Badge>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              This product&apos;s connection state could not be loaded. Other products are unaffected.
            </p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
            <div className="flex flex-wrap gap-2">
              {resolved === 'connected' && (
                <Button size="sm" onClick={onOpen}>
                  {openLabel}
                </Button>
              )}
              {resolved === 'needs_configuration' && canManage && (
                <Button size="sm" onClick={onConfigure}>
                  Configure
                </Button>
              )}
              {(resolved === 'not_connected' || resolved === 'needs_attention') && canManage && (
                <Button size="sm" variant={resolved === 'needs_attention' ? 'outline' : 'default'} onClick={onConnect}>
                  {connectLabel}
                </Button>
              )}
              {resolved !== 'connected' && !canManage && (
                <p className="text-sm text-muted-foreground">Ask a project editor to set this up.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Google({
  projectId,
  role,
  onOpenSettings,
  onOpenView,
}: {
  projectId: string;
  role: string;
  onOpenSettings: () => void;
  onOpenView: (view: 'keywords' | 'analytics' | 'ads') => void;
}) {
  const gsc = useAsync(() => projectGscState(projectId), [projectId]);
  const analytics = useAsync(() => projectAnalyticsState(projectId), [projectId]);
  const ads = useAsync(() => projectAdsState(projectId), [projectId]);
  const canManage = role !== 'viewer';

  const loading = gsc.loading || analytics.loading || ads.loading;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Google"
        description="Each Google product is authorized separately. Each project chooses which Search Console property, Analytics property and Ads customer it reports on."
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading Google connections…</p>
      ) : (
        <div className="grid gap-4">
          <GoogleProductCard
            title="Search Console"
            description="Organic queries and clicks your site is seen for."
            state={gsc.data ? googleProductState(gsc.data) : null}
            detail={gsc.data?.current?.site_url ?? null}
            error={gsc.error}
            canManage={canManage}
            openLabel="View search queries"
            connectLabel="Connect Search Console"
            onConnect={() => void connectGoogle()}
            onConfigure={onOpenSettings}
            onOpen={() => onOpenView('keywords')}
            onRetry={() => void gsc.reload()}
          />
          <GoogleProductCard
            title="Analytics"
            description="Which pages actually receive traffic (GA4)."
            state={analytics.data ? googleProductState(analytics.data) : null}
            detail={analytics.data?.current?.property_name ?? null}
            error={analytics.error}
            canManage={canManage}
            openLabel="View page traffic"
            connectLabel="Connect Analytics"
            onConnect={() => void connectAnalytics()}
            onConfigure={onOpenSettings}
            onOpen={() => onOpenView('analytics')}
            onRetry={() => void analytics.reload()}
          />
          <GoogleProductCard
            title="Ads"
            description="Search terms and keywords receiving paid traffic."
            state={ads.data ? googleProductState(ads.data) : null}
            detail={ads.data?.current?.name ?? null}
            error={ads.error}
            canManage={canManage}
            openLabel="View paid search"
            connectLabel="Connect Ads"
            onConnect={() => void connectAds()}
            onConfigure={onOpenSettings}
            onOpen={() => onOpenView('ads')}
            onRetry={() => void ads.reload()}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Google Analytics (GA4) service (P4): the read-only page-traffic brain.
 *
 * Sits between the routes/UI and the GA4 API client:
 *   GoogleAnalyticsClient -> GoogleAnalyticsService -> PageTrafficReport
 *
 * It owns the account-scoped token lifecycle (read encrypted tokens under the
 * account's 'ga4' integration, refresh once on 401), validates a selected
 * property against the account's live Google metadata (never trusting a
 * client-supplied id beyond the project binding), normalizes responses into the
 * shared application DTOs and maps Google failures to the platform error
 * vocabulary. No Google payload, token or client secret leaves this layer.
 *
 * The account connection and the project binding are deliberately separate:
 * credentials live once per account integration; a project stores only its GA4
 * property reference (seo_project_analytics). A project with no Analytics
 * property stays fully functional.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AnalyticsConnectionDto,
  AnalyticsPageTrafficReportDto,
  AnalyticsPeriodDays,
  AnalyticsPropertyDto,
} from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { refreshAccessToken } from '../providers/gsc/oauth.js';
import {
  GoogleAnalyticsClient,
  GoogleAnalyticsError,
  UnauthorizedError,
  normalizePropertyId,
  type AnalyticsPropertyMetadata,
  type Ga4RequestObserver,
  type PageTrafficDailyRow,
} from '../providers/ga4/googleAnalyticsClient.js';
import { emitGa4RequestUsage } from '../providers/ga4/providerUsage.js';
import { usageScopeContext } from './usageInstrumentation.js';

/** Encrypted-credential keys under which the GA4 token pair is stored. */
const TOKEN_KEYS = {
  access: 'google_access_token',
  refresh: 'google_refresh_token',
  scope: 'google_token_scope',
} as const;

/** Supported page-traffic periods; the UI offers exactly these. */
export const ANALYTICS_PERIODS: AnalyticsPeriodDays[] = [7, 28, 90];
export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriodDays = 28;

/** Row cap per page-traffic report (bounded to avoid huge Analytics datasets). */
export const PAGE_TRAFFIC_LIMIT = 100;
/** Row cap per daily page-traffic sync (date x path rows over the window). */
export const PAGE_TRAFFIC_DAILY_LIMIT = 5000;

type Row = Record<string, unknown>;

/** Parse a requested period into the supported set, defaulting to 28 days. */
export function resolveAnalyticsPeriodDays(raw: unknown): AnalyticsPeriodDays {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return (ANALYTICS_PERIODS as number[]).includes(n) ? (n as AnalyticsPeriodDays) : DEFAULT_ANALYTICS_PERIOD;
}

/** UTC YYYY-MM-DD for `date` shifted by `days`. */
function shiftDate(date: Date, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Map a Google property metadata record into the application DTO. */
function toPropertyDto(meta: AnalyticsPropertyMetadata): AnalyticsPropertyDto {
  return { property_id: meta.propertyId, property_name: meta.propertyName, property_url: meta.propertyUrl };
}

export class GoogleAnalyticsService {
  constructor(
    private readonly container: ServiceContainer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get sb(): SupabaseClient {
    return this.container.sb;
  }

  // -- account connection --------------------------------------------------

  /** The account's account-scoped (project_id NULL) GA4 integration, if any. */
  private async accountIntegration(accountId: string): Promise<Row | null> {
    const { data, error } = await this.sb
      .from('seo_integrations')
      .select('*')
      .eq('account_id', accountId)
      .is('project_id', null)
      .eq('provider_type', 'ga4')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ApiError(500, 'storage_error', 'Could not read the Google Analytics connection');
    return (data as Row | null) ?? null;
  }

  /** Connection state for the UI (no secrets; email comes from sealed config). */
  async connectionState(accountId: string): Promise<AnalyticsConnectionDto> {
    const integration = await this.accountIntegration(accountId);
    if (!integration) {
      return { connected: false, integration_id: null, status: null, account_email: null, error: null };
    }
    const status = String(integration.status ?? 'disconnected');
    const config = (integration.config as Row | null) ?? {};
    const lastError = (integration.last_error as Row | null)?.message;
    return {
      connected: status === 'connected' || status === 'connecting',
      integration_id: String(integration.id),
      status,
      account_email: typeof config.google_email === 'string' ? config.google_email : null,
      error: typeof lastError === 'string' ? lastError : null,
    };
  }

  /**
   * Persist one real GA4 API request as a project-scoped usage fact (P4.5). The
   * observer is only built when the caller supplies real project scope, so
   * account-scoped discovery (no project) emits nothing rather than a
   * fabricated project fact.
   */
  private usageObserver(args: { projectId: string; userId: string | null; sourceId?: string | null } | undefined): Ga4RequestObserver | undefined {
    if (!args) return undefined;
    const usage = usageScopeContext({ sink: this.container.usageEvents, sourceId: args.sourceId ?? null, userId: args.userId });
    if (!usage) return undefined;
    return (operation, success) =>
      emitGa4RequestUsage({ usage, projectId: args.projectId, userId: args.userId, operation, success });
  }

  /**
   * Run `fn` against a GA4 client using the stored access token, refreshing it
   * once and retrying on a 401. Two consecutive 401s mean the refresh token is
   * itself invalid, so the caller must reconnect - surfaced as a distinct code
   * the UI can turn into "reconnect Google Analytics".
   *
   * When `usageArgs` carries real project scope, every actual Analytics API
   * request made by either client attempt is recorded via the request observer.
   */
  private async withClient<T>(
    integration: Row,
    fn: (client: GoogleAnalyticsClient) => Promise<T>,
    usageArgs?: { projectId: string; userId: string | null; sourceId?: string | null },
  ): Promise<T> {
    const integrationId = String(integration.id);
    const creds = this.container.credentials.reader({ integrationId }, 'ga4');
    const access = await creds.get(TOKEN_KEYS.access);
    const refresh = await creds.get(TOKEN_KEYS.refresh);
    if (!access || !refresh) {
      throw new ApiError(403, 'analytics_reauthorization_required', 'Google Analytics authorization expired. Reconnect Google Analytics.');
    }
    const observe = this.usageObserver(usageArgs);
    try {
      return await fn(new GoogleAnalyticsClient(access, fetch, observe));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const clientId = this.container.config.env.GOOGLE_CLIENT_ID;
      const clientSecret = this.container.config.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw ApiError.notConfigured('Google OAuth is not configured on the server');
      }
      let tokens;
      try {
        tokens = await refreshAccessToken({ clientId, clientSecret, refreshToken: refresh });
      } catch {
        throw new ApiError(403, 'analytics_reauthorization_required', 'Google Analytics authorization expired. Reconnect Google Analytics.');
      }
      await creds.set(TOKEN_KEYS.access, tokens.access_token, { scope: tokens.scope });
      try {
        return await fn(new GoogleAnalyticsClient(tokens.access_token, fetch, observe));
      } catch (retryErr) {
        if (retryErr instanceof UnauthorizedError) {
          throw new ApiError(403, 'analytics_reauthorization_required', 'Google Analytics authorization expired. Reconnect Google Analytics.');
        }
        throw retryErr;
      }
    }
  }

  /** Wrap a Google Analytics API failure in the platform error vocabulary. */
  private mapProviderError(err: unknown): never {
    if (err instanceof ApiError) throw err;
    if (err instanceof GoogleAnalyticsError) {
      throw new ApiError(502, 'analytics_unavailable', 'Google Analytics could not be reached. Try again in a moment.');
    }
    throw err;
  }

  // -- property discovery --------------------------------------------------

  /** Live GA4 properties the account's authorization can read. */
  async listProperties(accountId: string): Promise<AnalyticsPropertyDto[]> {
    const integration = await this.accountIntegration(accountId);
    if (!integration || !['connected', 'connecting'].includes(String(integration.status))) {
      throw ApiError.badRequest('Connect Google Analytics to your account first');
    }
    try {
      const properties = await this.withClient(integration, (client) => client.listProperties());
      return properties.map(toPropertyDto);
    } catch (err) {
      this.mapProviderError(err);
    }
  }

  /**
   * Validate a property id against the account's live metadata and return the
   * authoritative name/url. A property the account cannot read (or that no
   * longer exists) is rejected - a client can never bind an arbitrary id.
   */
  async resolveProperty(accountId: string, propertyId: string): Promise<AnalyticsPropertyDto> {
    const wanted = normalizePropertyId(propertyId);
    if (!/^[0-9]{1,32}$/.test(wanted)) {
      throw ApiError.badRequest('Invalid Google Analytics property id');
    }
    const available = await this.listProperties(accountId);
    const match = available.find((p) => p.property_id === wanted);
    if (!match) {
      throw ApiError.badRequest('This Google Analytics property is no longer accessible. Choose another property.');
    }
    return match;
  }

  // -- project binding -----------------------------------------------------

  /** The GA4 property currently bound to a project, or null. */
  async currentProperty(projectId: string): Promise<AnalyticsPropertyDto | null> {
    const { data, error } = await this.sb
      .from('seo_project_analytics')
      .select('property_id, property_name, property_url')
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw new ApiError(500, 'storage_error', 'Could not read the project Analytics property');
    if (!data) return null;
    const row = data as Row;
    return {
      property_id: String(row.property_id),
      property_name: String(row.property_name),
      property_url: typeof row.property_url === 'string' ? row.property_url : null,
    };
  }

  /**
   * Select (or replace) the project's GA4 property. The property must belong to
   * the account's live Google metadata; only its reference is stored, never any
   * credential. Replacing an existing binding simply upserts.
   */
  async selectProperty(args: { accountId: string; projectId: string; userId: string; propertyId: string }): Promise<AnalyticsPropertyDto> {
    const property = await this.resolveProperty(args.accountId, args.propertyId);
    const { error } = await this.sb.from('seo_project_analytics').upsert(
      {
        project_id: args.projectId,
        property_id: property.property_id,
        property_name: property.property_name,
        property_url: property.property_url,
        created_by: args.userId,
      } as never,
      { onConflict: 'project_id' },
    );
    if (error) throw ApiError.badRequest(`Could not save the Analytics property: ${error.message}`);
    return property;
  }

  /** Remove the project's Analytics binding (the account connection stays). */
  async clearProperty(projectId: string): Promise<void> {
    const { error } = await this.sb.from('seo_project_analytics').delete().eq('project_id', projectId);
    if (error) throw new ApiError(500, 'storage_error', 'Could not clear the Analytics property');
  }

  // -- page traffic --------------------------------------------------------

  /**
   * Page-traffic report for the project's bound property over the requested
   * period. A project without a bound property returns an empty report with
   * `property: null` (the UI then prompts for a property) - that is not an
   * error, and never a fabricated zero row.
   */
  async pageTraffic(args: { accountId: string; projectId: string; days: AnalyticsPeriodDays; userId?: string | null }): Promise<AnalyticsPageTrafficReportDto> {
    const end = shiftDate(this.now(), 0);
    const start = shiftDate(this.now(), -(args.days - 1));
    const period = { days: args.days, start_date: start, end_date: end };
    const property = await this.currentProperty(args.projectId);
    if (!property) {
      return { property: null, period, rows: [], limit: PAGE_TRAFFIC_LIMIT, truncated: false };
    }
    const integration = await this.accountIntegration(args.accountId);
    if (!integration || !['connected', 'connecting'].includes(String(integration.status))) {
      throw ApiError.badRequest("Google Analytics isn't connected. Connect Google Analytics to see page traffic.");
    }
    try {
      const report = await this.withClient(
        integration,
        (client) => client.runPageTrafficReport(property.property_id, { startDate: start, endDate: end, limit: PAGE_TRAFFIC_LIMIT }),
        { projectId: args.projectId, userId: args.userId ?? null },
      );
      return { property, period, rows: report.rows, limit: PAGE_TRAFFIC_LIMIT, truncated: report.truncated };
    } catch (err) {
      this.mapProviderError(err);
    }
  }

  /**
   * Daily page traffic (date x path) for the project's bound property over the
   * last `days`, for the measurement sync to persist into seo_page_traffic. A
   * project without a bound property returns `property: null` with no rows -
   * that is not an error. The account must have a connected GA4 integration;
   * the worker checks that first and skips the sync rather than enqueuing a job
   * that could only fail.
   */
  async dailyPageTraffic(args: {
    accountId: string;
    projectId: string;
    days: number;
    userId?: string | null;
    sourceId?: string | null;
  }): Promise<{
    property: AnalyticsPropertyDto | null;
    startDate: string;
    endDate: string;
    rows: PageTrafficDailyRow[];
    truncated: boolean;
  }> {
    const endDate = shiftDate(this.now(), 0);
    const startDate = shiftDate(this.now(), -(args.days - 1));
    const property = await this.currentProperty(args.projectId);
    if (!property) return { property: null, startDate, endDate, rows: [], truncated: false };
    const integration = await this.accountIntegration(args.accountId);
    if (!integration || !['connected', 'connecting'].includes(String(integration.status))) {
      throw ApiError.badRequest("Google Analytics isn't connected. Connect Google Analytics to sync page traffic.");
    }
    try {
      const report = await this.withClient(
        integration,
        (client) =>
          client.runPageTrafficDailyReport(property.property_id, {
            startDate,
            endDate,
            limit: PAGE_TRAFFIC_DAILY_LIMIT,
          }),
        { projectId: args.projectId, userId: args.userId ?? null, sourceId: args.sourceId ?? null },
      );
      return { property, startDate, endDate, rows: report.rows, truncated: report.truncated };
    } catch (err) {
      this.mapProviderError(err);
    }
  }
}

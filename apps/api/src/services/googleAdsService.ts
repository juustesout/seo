/**
 * Google Ads service (P5): the read-only paid search intelligence brain.
 *
 * Sits between the routes/UI and the Google Ads API client:
 *   GoogleAdsClient -> GoogleAdsService -> GoogleAdsReportDto
 *
 * It owns the account-scoped token lifecycle (read encrypted tokens under the
 * account's 'ads' integration, refresh once on 401), discovers the customer
 * accounts the authorization can reach, validates a selected customer against
 * the account's live Google Ads metadata (never trusting a client-supplied id
 * beyond the project binding), normalizes responses into the shared application
 * DTOs and maps Google failures to the platform error vocabulary. No Google
 * payload, token or client secret leaves this layer.
 *
 * The account connection and the project binding are deliberately separate:
 * credentials live once per account integration; a project stores only its
 * Google Ads customer reference (seo_project_ads). A project with no Ads
 * customer stays fully functional.
 *
 * Read-only by construction: only discovery and reporting queries are issued.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  GoogleAdsConnectionDto,
  GoogleAdsCustomerDto,
  GoogleAdsReportDto,
  GoogleAdsPeriodDays,
} from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { refreshAccessToken } from '../providers/gsc/oauth.js';
import {
  GoogleAdsClient,
  GoogleAdsError,
  UnauthorizedError,
  isValidAdsFilter,
  normalizeCustomerId,
  type GoogleAdsCustomerMeta,
  type GoogleAdsRequestObserver,
} from '../providers/googleAds/googleAdsClient.js';
import { emitAdsRequestUsage } from '../providers/googleAds/providerUsage.js';
import { usageScopeContext } from './usageInstrumentation.js';

/** Encrypted-credential keys under which the Google Ads token pair is stored. */
const TOKEN_KEYS = {
  access: 'google_access_token',
  refresh: 'google_refresh_token',
  scope: 'google_token_scope',
} as const;

/** Supported search-intelligence periods; the UI offers exactly these. */
export const ADS_PERIODS: GoogleAdsPeriodDays[] = [7, 28, 90];
export const DEFAULT_ADS_PERIOD: GoogleAdsPeriodDays = 28;

/** Row cap per report list (bounded to avoid huge Google Ads datasets). */
export const ADS_REPORT_LIMIT = 100;

type Row = Record<string, unknown>;

/** Parse a requested period into the supported set, defaulting to 28 days. */
export function resolveAdsPeriodDays(raw: unknown): GoogleAdsPeriodDays {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return (ADS_PERIODS as number[]).includes(n) ? (n as GoogleAdsPeriodDays) : DEFAULT_ADS_PERIOD;
}

/** UTC YYYY-MM-DD for `date` shifted by `days`. */
function shiftDate(date: Date, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Map Google-reported customer metadata into the application DTO. */
function toCustomerDto(meta: GoogleAdsCustomerMeta, loginCustomerId: string | null): GoogleAdsCustomerDto {
  return {
    customer_id: meta.customerId,
    name: meta.name,
    currency_code: meta.currencyCode,
    is_manager: meta.isManager,
    login_customer_id: loginCustomerId,
    status: meta.status,
  };
}

export class GoogleAdsService {
  constructor(
    private readonly container: ServiceContainer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get sb(): SupabaseClient {
    return this.container.sb;
  }

  /** Client options from server config: version + optional legacy dev token. */
  private clientOptions(observe?: GoogleAdsRequestObserver) {
    return {
      version: this.container.config.env.GOOGLE_ADS_API_VERSION,
      developerToken: this.container.config.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
      observe,
    };
  }

  // -- account connection --------------------------------------------------

  /** The account's account-scoped (project_id NULL) Ads integration, if any. */
  private async accountIntegration(accountId: string): Promise<Row | null> {
    const { data, error } = await this.sb
      .from('seo_integrations')
      .select('*')
      .eq('account_id', accountId)
      .is('project_id', null)
      .eq('provider_type', 'ads')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ApiError(500, 'storage_error', 'Could not read the Google Ads connection');
    return (data as Row | null) ?? null;
  }

  /** Connection state for the UI (no secrets; email comes from sealed config). */
  async connectionState(accountId: string): Promise<GoogleAdsConnectionDto> {
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
   * Persist one real Google Ads API request as a project-scoped usage fact
   * (P5). The observer is only built when the caller supplies real project
   * scope, so account-scoped discovery (no project) emits nothing rather than a
   * fabricated project fact.
   */
  private usageObserver(args: { projectId: string; userId: string | null } | undefined): GoogleAdsRequestObserver | undefined {
    if (!args) return undefined;
    const usage = usageScopeContext({ sink: this.container.usageEvents, sourceId: null, userId: args.userId });
    if (!usage) return undefined;
    return (operation, success) =>
      emitAdsRequestUsage({ usage, projectId: args.projectId, userId: args.userId, operation, success });
  }

  /**
   * Run `fn` against a Google Ads client using the stored access token,
   * refreshing it once and retrying on a 401. Two consecutive 401s mean the
   * refresh token is itself invalid, so the caller must reconnect.
   *
   * When `usageArgs` carries real project scope, every actual Ads API request
   * made by either client attempt is recorded via the request observer.
   */
  private async withClient<T>(
    integration: Row,
    fn: (client: GoogleAdsClient) => Promise<T>,
    usageArgs?: { projectId: string; userId: string | null },
  ): Promise<T> {
    const integrationId = String(integration.id);
    const creds = this.container.credentials.reader({ integrationId }, 'ads');
    const access = await creds.get(TOKEN_KEYS.access);
    const refresh = await creds.get(TOKEN_KEYS.refresh);
    if (!access || !refresh) {
      throw new ApiError(403, 'ads_reauthorization_required', 'Google Ads authorization expired. Reconnect Google Ads.');
    }
    const observe = this.usageObserver(usageArgs);
    try {
      return await fn(new GoogleAdsClient(access, this.clientOptions(observe)));
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
        throw new ApiError(403, 'ads_reauthorization_required', 'Google Ads authorization expired. Reconnect Google Ads.');
      }
      await creds.set(TOKEN_KEYS.access, tokens.access_token, { scope: tokens.scope });
      try {
        return await fn(new GoogleAdsClient(tokens.access_token, this.clientOptions(observe)));
      } catch (retryErr) {
        if (retryErr instanceof UnauthorizedError) {
          throw new ApiError(403, 'ads_reauthorization_required', 'Google Ads authorization expired. Reconnect Google Ads.');
        }
        throw retryErr;
      }
    }
  }

  /** Wrap a Google Ads API failure in the platform error vocabulary. */
  private mapProviderError(err: unknown): never {
    if (err instanceof ApiError) throw err;
    if (err instanceof GoogleAdsError) {
      const code = err.providerCode ?? '';
      if (err.status === 429 || code === 'RESOURCE_EXHAUSTED' || err.reason === 'RESOURCE_EXHAUSTED') {
        throw new ApiError(429, 'ads_quota_exceeded', 'Google Ads rate limit reached. Try again in a moment.');
      }
      if (code === 'CUSTOMER_NOT_FOUND' || code === 'NOT_ADS_USER') {
        throw ApiError.badRequest('This Google Ads customer could not be found or is no longer accessible.');
      }
      if (
        code === 'USER_PERMISSION_DENIED' ||
        code === 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' ||
        code === 'CUSTOMER_NOT_ENABLED' ||
        err.reason === 'PERMISSION_DENIED'
      ) {
        throw new ApiError(
          403,
          'ads_permission_denied',
          'Google Ads denied access to this customer, or the Google Cloud project is not approved for production accounts.',
        );
      }
      if (err.status === 400 || code === 'INVALID_ARGUMENT' || code === 'QUERY_ERROR' || err.reason === 'INVALID_ARGUMENT') {
        throw ApiError.badRequest('The Google Ads query was rejected. Adjust the filter or period and try again.');
      }
      throw new ApiError(502, 'ads_unavailable', 'Google Ads could not be reached. Try again in a moment.');
    }
    throw err;
  }

  // -- customer discovery --------------------------------------------------

  /**
   * Live Google Ads customers the account's authorization can reach: every
   * directly accessible customer, plus the client accounts of directly
   * accessible manager (MCC) accounts resolved with `login-customer-id`.
   * Returns an empty list when Google reports none.
   */
  async listCustomers(accountId: string): Promise<GoogleAdsCustomerDto[]> {
    const integration = await this.accountIntegration(accountId);
    if (!integration || !['connected', 'connecting'].includes(String(integration.status))) {
      throw ApiError.badRequest('Connect Google Ads to your account first');
    }
    try {
      return await this.withClient(integration, async (client) => {
        const accessible = await client.listAccessibleCustomers();
        const customers: GoogleAdsCustomerDto[] = [];
        const seen = new Set<string>();
        for (const id of accessible) {
          const meta = await client.getCustomerMeta(id);
          if (!meta || seen.has(meta.customerId)) continue;
          seen.add(meta.customerId);
          customers.push(toCustomerDto(meta, null));
        }
        // Expand directly accessible manager accounts one level so a user who
        // reaches a client only through its manager can still select it.
        for (const manager of customers.filter((c) => c.is_manager)) {
          const children = await client.listManagedCustomers(manager.customer_id);
          for (const child of children) {
            if (child.customerId === manager.customer_id || seen.has(child.customerId)) continue;
            seen.add(child.customerId);
            customers.push(toCustomerDto(child, manager.customer_id));
          }
        }
        return customers;
      });
    } catch (err) {
      this.mapProviderError(err);
    }
  }

  /**
   * Validate a customer id against the account's live Google Ads metadata and
   * return the authoritative record. A customer the account cannot reach (or
   * that no longer exists) is rejected - a client can never bind an arbitrary
   * id.
   */
  async resolveCustomer(accountId: string, customerId: string): Promise<GoogleAdsCustomerDto> {
    const wanted = normalizeCustomerId(customerId);
    if (!/^[0-9]{1,20}$/.test(wanted)) {
      throw ApiError.badRequest('Invalid Google Ads customer id');
    }
    const available = await this.listCustomers(accountId);
    const match = available.find((c) => c.customer_id === wanted);
    if (!match) {
      throw ApiError.badRequest('This Google Ads customer is no longer accessible. Choose another customer.');
    }
    return match;
  }

  // -- project binding -----------------------------------------------------

  /** The Google Ads customer currently bound to a project, or null. */
  async currentCustomer(projectId: string): Promise<GoogleAdsCustomerDto | null> {
    const { data, error } = await this.sb
      .from('seo_project_ads')
      .select('customer_id, customer_name, currency_code, is_manager, login_customer_id')
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw new ApiError(500, 'storage_error', 'Could not read the project Google Ads customer');
    if (!data) return null;
    const row = data as Row;
    return {
      customer_id: String(row.customer_id),
      name: String(row.customer_name),
      currency_code: typeof row.currency_code === 'string' ? row.currency_code : null,
      is_manager: row.is_manager === true,
      login_customer_id: typeof row.login_customer_id === 'string' ? row.login_customer_id : null,
      status: null,
    };
  }

  /**
   * Select (or replace) the project's Google Ads customer. The customer must be
   * reachable by the account's live Google Ads metadata; only its reference is
   * stored, never any credential. Replacing an existing binding simply upserts.
   */
  async selectCustomer(args: {
    accountId: string;
    projectId: string;
    userId: string;
    customerId: string;
  }): Promise<GoogleAdsCustomerDto> {
    const customer = await this.resolveCustomer(args.accountId, args.customerId);
    const { error } = await this.sb.from('seo_project_ads').upsert(
      {
        project_id: args.projectId,
        customer_id: customer.customer_id,
        customer_name: customer.name,
        currency_code: customer.currency_code,
        is_manager: customer.is_manager,
        login_customer_id: customer.login_customer_id,
        created_by: args.userId,
      } as never,
      { onConflict: 'project_id' },
    );
    if (error) throw ApiError.badRequest(`Could not save the Google Ads customer: ${error.message}`);
    return customer;
  }

  /** Remove the project's Ads binding (the account connection stays). */
  async clearCustomer(projectId: string): Promise<void> {
    const { error } = await this.sb.from('seo_project_ads').delete().eq('project_id', projectId);
    if (error) throw new ApiError(500, 'storage_error', 'Could not clear the Google Ads customer');
  }

  // -- read-only intelligence ----------------------------------------------

  /**
   * Search-term and keyword intelligence for the project's bound customer over
   * the requested period. A project without a bound customer returns an empty
   * report with `customer: null` (the UI then prompts for a customer) - that is
   * not an error, and never a fabricated zero row.
   */
  async report(args: {
    accountId: string;
    projectId: string;
    days: GoogleAdsPeriodDays;
    filter?: string | null;
    userId?: string | null;
  }): Promise<GoogleAdsReportDto> {
    const end = shiftDate(this.now(), 0);
    const start = shiftDate(this.now(), -(args.days - 1));
    const period = { days: args.days, start_date: start, end_date: end };
    const filter = args.filter?.trim() ? args.filter.trim() : null;
    if (filter && !isValidAdsFilter(filter)) {
      throw ApiError.badRequest('The Google Ads filter may only contain letters, numbers, spaces, dots and hyphens (max 50).');
    }
    const customer = await this.currentCustomer(args.projectId);
    if (!customer) {
      return {
        customer: null,
        period,
        search_terms: [],
        keywords: [],
        limit: ADS_REPORT_LIMIT,
        search_terms_truncated: false,
        keywords_truncated: false,
      };
    }
    const integration = await this.accountIntegration(args.accountId);
    if (!integration || !['connected', 'connecting'].includes(String(integration.status))) {
      throw ApiError.badRequest("Google Ads isn't connected. Connect Google Ads to see search intelligence.");
    }
    try {
      const result = await this.withClient(
        integration,
        async (client) => {
          const query = {
            startDate: start,
            endDate: end,
            limit: ADS_REPORT_LIMIT,
            filter,
            loginCustomerId: customer.login_customer_id,
          };
          const [searchTerms, keywords] = await Promise.all([
            client.searchTerms(customer.customer_id, query),
            client.keywords(customer.customer_id, query),
          ]);
          return { searchTerms, keywords };
        },
        { projectId: args.projectId, userId: args.userId ?? null },
      );
      return {
        customer: { customer_id: customer.customer_id, name: customer.name, currency_code: customer.currency_code },
        period,
        search_terms: result.searchTerms.rows,
        keywords: result.keywords.rows,
        limit: ADS_REPORT_LIMIT,
        search_terms_truncated: result.searchTerms.truncated,
        keywords_truncated: result.keywords.truncated,
      };
    } catch (err) {
      this.mapProviderError(err);
    }
  }
}

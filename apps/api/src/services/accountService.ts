/**
 * Account service (Stage 4): account-scoped Google connection state, project
 * summaries and the cross-project overview aggregation. The account owns the
 * Google Search Console connection and the GSC property registry; projects
 * attach registry properties individually via seo_project_properties.
 *
 * Metrics are aggregated from the project-scoped seo_gsc_performance rows, so
 * an account overview never fabricates numbers: when no project has data the
 * overview is reported as not ready, not as zeroes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type {
  AccountProjectSummaryDto,
  AccountRecentActivityDto,
  GscConnectionDto,
  GscRegistryPropertyDto,
  ProjectSummary,
} from '@seo/contracts';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/** Resolve (and lazily create) the account a user owns. */
export async function resolveAccountId(sb: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await sb.rpc('seo_ensure_account', { p_user: userId });
  if (error) {
    logger.error({ error }, 'account resolution failed');
    throw new ApiError(500, 'storage_error', 'Could not resolve your account');
  }
  const accountId = Array.isArray(data) ? (data[0] as Row | null)?.id : (data as string | null);
  if (typeof accountId !== 'string') {
    throw new ApiError(500, 'storage_error', 'Could not resolve your account');
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Google connection state
// ---------------------------------------------------------------------------

export interface GoogleConnectionRow {
  id: string;
  status: string;
  last_error: Row | null;
  created_at: string;
}

/** The account's account-scoped (project_id NULL) GSC integration, if any. */
export async function accountGscIntegration(
  sb: SupabaseClient,
  accountId: string,
): Promise<GoogleConnectionRow | null> {
  const { data, error } = await sb
    .from('seo_integrations')
    .select('id, status, last_error, created_at')
    .eq('account_id', accountId)
    .is('project_id', null)
    .eq('provider_type', 'gsc')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error({ error }, 'account gsc integration lookup failed');
    throw new ApiError(500, 'storage_error', 'Could not read the Google connection');
  }
  return data ? (data as unknown as GoogleConnectionRow) : null;
}

export async function googleConnectionState(sb: SupabaseClient, accountId: string): Promise<GscConnectionDto> {
  const integration = await accountGscIntegration(sb, accountId);
  if (!integration) {
    return { connected: false, integration_id: null, status: null, last_sync_at: null, error: null };
  }
  const connected = integration.status === 'connected' || integration.status === 'connecting';
  let lastSyncAt: string | null = null;
  const { data: syncRow } = await sb
    .from('seo_data_sources')
    .select('last_synced_at')
    .eq('integration_id', integration.id)
    .not('last_synced_at', 'is', null)
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (syncRow) lastSyncAt = (syncRow as Row).last_synced_at as string | null;
  const lastError = (integration.last_error as Row | null)?.message ?? null;
  return {
    connected,
    integration_id: integration.id,
    status: integration.status,
    last_sync_at: lastSyncAt,
    error: typeof lastError === 'string' ? lastError : null,
  };
}

// ---------------------------------------------------------------------------
// Project membership / ids
// ---------------------------------------------------------------------------

/** Project ids owned by this account. */
export async function accountProjectIds(sb: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await sb.from('seo_projects').select('id').eq('account_id', accountId);
  if (error) throw new ApiError(500, 'storage_error', 'Could not read account projects');
  return (data ?? []).map((r) => (r as Row).id as string);
}

export interface AccountProjectRow {
  id: string;
  name: string;
  created_by: string;
}

async function countRows(
  sb: SupabaseClient,
  table: string,
  projectId: string,
  extra?: { eq?: [string, string] },
): Promise<number> {
  let q = sb.from(table as never).select('id', { count: 'exact', head: true }).eq('project_id', projectId);
  if (extra?.eq) q = q.eq(extra.eq[0], extra.eq[1]);
  const { count, error } = await q;
  if (error) throw new ApiError(500, 'storage_error', `Could not count ${table} rows`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Project summaries (account home)
// ---------------------------------------------------------------------------

export async function buildAccountProjects(
  sb: SupabaseClient,
  userId: string,
  accountId: string,
): Promise<AccountProjectSummaryDto[]> {
  const { data: memberships } = await sb
    .from('seo_project_members')
    .select('project_id, role')
    .eq('user_id', userId);
  const roleMap = new Map((memberships ?? []).map((m) => [m.project_id as string, m.role as string]));

  const { data: projectsData, error: projectsError } = await sb
    .from('seo_projects')
    .select('*')
    .eq('account_id', accountId);
  if (projectsError) throw new ApiError(500, 'storage_error', 'Could not read account projects');
  const rows = (projectsData ?? []) as unknown as Array<ProjectSummary & Row>;

  if (rows.length === 0) return [];

  const projectIds = rows.map((p) => p.id);
  const { data: links } = await sb
    .from('seo_project_properties')
    .select('project_id, property_id, is_primary')
    .in('project_id', projectIds);
  const { data: registry } = await sb
    .from('seo_gsc_properties')
    .select('id, site_url')
    .eq('account_id', accountId)
    .in(
      'id',
      (links ?? []).map((l) => l.property_id as string),
    );
  const siteByProperty = new Map((registry ?? []).map((r) => [r.id as string, r.site_url as string]));
  const linkByProject = new Map<string, Row>();
  for (const l of links ?? []) {
    const pid = l.project_id as string;
    if (!linkByProject.has(pid)) linkByProject.set(pid, l as unknown as Row);
  }

  const summaries: AccountProjectSummaryDto[] = [];
  for (const p of rows) {
    const id = p.id;
    const [memberCount, domainCount, integrationCount, connectedCount, jobCount, contentCount] = await Promise.all([
      countRows(sb, 'seo_project_members', id),
      countRows(sb, 'seo_domains', id),
      countRows(sb, 'seo_integrations', id),
      countRows(sb, 'seo_integrations', id, { eq: ['status', 'connected'] }),
      countRows(sb, 'seo_sync_jobs', id),
      countRows(sb, 'seo_content', id),
    ]);
    const { data: lastSync } = await sb
      .from('seo_data_sources')
      .select('last_synced_at')
      .eq('project_id', id)
      .not('last_synced_at', 'is', null)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const link = linkByProject.get(id);
    summaries.push({
      id,
      name: p.name,
      slug: p.slug ?? null,
      description: p.description ?? null,
      website_url: p.website_url ?? null,
      timezone: p.timezone ?? 'UTC',
      settings: p.settings ?? {},
      created_by: p.created_by,
      created_at: p.created_at,
      updated_at: p.updated_at,
      role: (roleMap.get(id) ?? 'viewer') as ProjectSummary['role'],
      member_count: memberCount,
      domain_count: domainCount,
      integration_count: integrationCount,
      connected_count: connectedCount,
      job_count: jobCount,
      last_sync_at: (lastSync?.last_synced_at as string | null) ?? null,
      property: link
        ? {
            property_id: link.property_id as string,
            site_url: siteByProperty.get(link.property_id as string) ?? '',
            is_primary: Boolean(link.is_primary),
          }
        : null,
      content_count: contentCount,
    });
  }
  return summaries;
}

export async function recentAccountActivity(
  sb: SupabaseClient,
  projectIds: string[],
  projectNames: Map<string, string>,
): Promise<AccountRecentActivityDto[]> {
  if (projectIds.length === 0) return [];
  const { data, error } = await sb
    .from('seo_audit_logs')
    .select('id, project_id, action, entity_type, entity_id, created_at, meta')
    .in('project_id', projectIds)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) return [];
  return (data ?? []).map((r) => {
    const pid = (r as Row).project_id as string | null;
    return {
      id: r.id as string,
      project_id: pid,
      project_name: pid ? (projectNames.get(pid) ?? null) : null,
      action: r.action as string,
      entity_type: r.entity_type as string,
      entity_id: (r.entity_id as string | null) ?? null,
      created_at: r.created_at as string,
      meta: ((r.meta as Row | null) ?? {}) as Record<string, unknown>,
    };
  });
}

// ---------------------------------------------------------------------------
// Registry properties
// ---------------------------------------------------------------------------

export async function registryProperties(
  sb: SupabaseClient,
  accountId: string,
): Promise<GscRegistryPropertyDto[]> {
  const { data: props, error } = await sb
    .from('seo_gsc_properties')
    .select('id, site_url, permission_level, verified_at, is_active, integration_id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the property registry');
  if ((props ?? []).length === 0) return [];

  const propertyIds = (props ?? []).map((r) => (r as Row).id as string);
  const { data: links } = await sb
    .from('seo_project_properties')
    .select('property_id, project_id')
    .in('property_id', propertyIds);
  const projectIds = [...new Set((links ?? []).map((l) => l.project_id as string))];
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await sb.from('seo_projects').select('id, name').in('id', projectIds);
    for (const pr of projects ?? []) projectNames.set(pr.id as string, pr.name as string);
  }
  const projectByProperty = new Map<string, string>();
  for (const l of links ?? []) projectByProperty.set(l.property_id as string, l.project_id as string);

  return (props ?? []).map((r) => {
    const pid = r.id as string;
    const linkedProjectId = projectByProperty.get(pid);
    return {
      id: pid,
      site_url: r.site_url as string,
      permission_level: (r.permission_level as string | null) ?? null,
      verified_at: (r.verified_at as string | null) ?? null,
      is_active: Boolean(r.is_active),
      integration_id: (r.integration_id as string | null) ?? null,
      linked_project: linkedProjectId
        ? { id: linkedProjectId, name: projectNames.get(linkedProjectId) ?? '' }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Overview aggregation (Overall Dashboard)
// ---------------------------------------------------------------------------

function pctChange(current: number, previous: number): number | null {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  return null;
}

export interface OverviewTotalsInput {
  integrationId: string | null;
  projects: AccountProjectRow[];
  days: number;
}

export interface AccountMetrics {
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    clicks_trend: number | null;
    impressions_trend: number | null;
  };
  series: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  properties: Array<{
    property_id: string;
    site_url: string;
    project_id: string;
    project_name: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
}

/**
 * Aggregate seo_gsc_performance across every project of the account over the
 * requested range. Callers gate this on a connected Google integration and at
 * least one attached property; rows only exist once real GSC data was synced.
 */
export async function aggregateAccountMetrics(
  sb: SupabaseClient,
  accountId: string,
  days: number,
): Promise<AccountMetrics | null> {
  const projectIds = await accountProjectIds(sb, accountId);
  if (projectIds.length === 0) return null;

  const { data: projectRows } = await sb.from('seo_projects').select('id, name').in('id', projectIds);
  const projectNames = new Map<string, string>();
  for (const p of projectRows ?? []) projectNames.set(p.id as string, p.name as string);

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = fmt(start);
  const prevStartDate = fmt(new Date(start.getTime() - days * 864e5));

  const { data: currentRows, error: curErr } = await sb
    .from('seo_gsc_performance')
    .select('property_id, project_id, date, clicks, impressions, ctr, position')
    .in('project_id', projectIds)
    .gte('date', startDate);
  if (curErr) throw new ApiError(500, 'storage_error', 'Could not aggregate account metrics');
  const { data: prevRows, error: prevErr } = await sb
    .from('seo_gsc_performance')
    .select('clicks, impressions')
    .in('project_id', projectIds)
    .gte('date', prevStartDate)
    .lt('date', startDate);
  if (prevErr) throw new ApiError(500, 'storage_error', 'Could not aggregate account metrics');

  const rows = (currentRows ?? []) as unknown as Array<Row>;
  if (rows.length === 0) return null;

  const { data: registry } = await sb
    .from('seo_gsc_properties')
    .select('id, site_url')
    .eq('account_id', accountId)
    .in(
      'id',
      [...new Set(rows.map((r) => r.property_id as string))],
    );
  const siteUrlByProperty = new Map<string, string>();
  for (const r of registry ?? []) siteUrlByProperty.set(r.id as string, r.site_url as string);

  const prev = (prevRows ?? []) as unknown as Array<Row>;
  const prevClicks = prev.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
  const prevImpressions = prev.reduce((s, r) => s + Number(r.impressions ?? 0), 0);

  const sum = { clicks: 0, impressions: 0, weightedPosition: 0 };
  for (const r of rows) {
    sum.clicks += Number(r.clicks ?? 0);
    sum.impressions += Number(r.impressions ?? 0);
    sum.weightedPosition += Number(r.position ?? 0) * Number(r.impressions ?? 0);
  }

  const byDate = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>();
  const byProperty = new Map<string, Row & { clicks: number; impressions: number; weightedPosition: number }>();
  for (const r of rows) {
    const date = r.date as string;
    const d = byDate.get(date) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
    d.clicks += Number(r.clicks ?? 0);
    d.impressions += Number(r.impressions ?? 0);
    d.weightedPosition += Number(r.position ?? 0) * Number(r.impressions ?? 0);
    byDate.set(date, d);

    const pid = r.property_id as string;
    const p = byProperty.get(pid) ?? { ...r, clicks: 0, impressions: 0, weightedPosition: 0 };
    p.clicks += Number(r.clicks ?? 0);
    p.impressions += Number(r.impressions ?? 0);
    p.weightedPosition += Number(r.position ?? 0) * Number(r.impressions ?? 0);
    byProperty.set(pid, p);
  }

  const ctrFor = (c: number, i: number) => (i > 0 ? Math.round((c / i) * 10000) / 100 : 0);
  const positionFor = (w: number, i: number) => (i > 0 ? Math.round((w / i) * 10) / 10 : 0);

  const series = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: ctrFor(d.clicks, d.impressions),
      position: positionFor(d.weightedPosition, d.impressions),
    }));

  const properties = [...byProperty.entries()].map(([propertyId, d]) => {
    const projectId = d.project_id as string;
    return {
      property_id: propertyId,
      site_url: siteUrlByProperty.get(propertyId) ?? '',
      project_id: projectId,
      project_name: projectNames.get(projectId) ?? '',
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: ctrFor(d.clicks, d.impressions),
      position: positionFor(d.weightedPosition, d.impressions),
    };
  });

  return {
    totals: {
      clicks: sum.clicks,
      impressions: sum.impressions,
      ctr: ctrFor(sum.clicks, sum.impressions),
      position: positionFor(sum.weightedPosition, sum.impressions),
      clicks_trend: pctChange(sum.clicks, prevClicks),
      impressions_trend: pctChange(sum.impressions, prevImpressions),
    },
    series,
    properties,
  };
}

/**
 * Platform administration contracts (P3).
 *
 * The platform administrator is a separate trust boundary from project
 * membership (owner/admin/editor/viewer). These DTOs are the read-only
 * operational surface the API serves under /api/admin/* to a registered
 * platform administrator. They intentionally contain no secrets: no tokens,
 * credentials, API key material or job payloads.
 */
import type { UsageReportDto } from './usageEvent.js';

/**
 * Operational counts. Each field maps to an unambiguous existing definition; no
 * "active user" style metric is invented. `usage_events_this_period` counts
 * recorded usage facts in the current UTC calendar month - it does not sum
 * quantities across units.
 */
export interface PlatformAdminOverviewDto {
  users: number;
  accounts: number;
  projects: number;
  jobs: number;
  active_jobs: number;
  failed_jobs: number;
  usage_events_this_period: number;
  usage_period_start: string;
  recent_jobs: PlatformAdminJobDto[];
}

/** One user as seen by the platform operator (identity + account association). */
export interface PlatformAdminUserDto {
  user_id: string;
  email: string | null;
  created_at: string | null;
  account_id: string | null;
  project_count: number;
}

/** One account with its owner and reach. */
export interface PlatformAdminAccountDto {
  account_id: string;
  name: string;
  owner_user_id: string;
  owner_email: string | null;
  created_at: string;
  project_count: number;
  /** Distinct users reachable across this account's projects. */
  member_count: number;
}

/** One project with its owning account and size. Status is not modeled, so omitted. */
export interface PlatformAdminProjectDto {
  project_id: string;
  name: string;
  account_id: string | null;
  created_by: string | null;
  created_at: string;
  member_count: number;
}

/** One recent job, safe for operators (no payload/error blobs). */
export interface PlatformAdminJobDto {
  job_id: string;
  project_id: string;
  project_name: string | null;
  provider: string;
  job_type: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  message: string | null;
}

/**
 * Cross-account usage aggregate. Reuses the existing {@link UsageReportDto}
 * shape (scope + aggregate rows); a null account/project means "all".
 */
export type PlatformAdminUsageDto = UsageReportDto;

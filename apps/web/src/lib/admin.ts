/**
 * Platform administration API client (P3).
 *
 * Thin wrappers over `/api/admin/*`. The server authorizes every call against
 * the platform-admin registry; these helpers add no client-side identity logic.
 * Used only by the admin views, which are mounted only for a registered
 * platform administrator.
 */
import type {
  AccountEntitlementDto,
  PlatformAdminAccountDto,
  PlatformAdminOverviewDto,
  PlatformAdminPlanDto,
  PlatformAdminProjectDto,
  PlatformAdminUserDto,
  UsageReportDto,
} from '@seo/contracts';
import { api } from './api';

export function adminOverview(): Promise<PlatformAdminOverviewDto> {
  return api('/admin/overview');
}

export function adminUsers(): Promise<PlatformAdminUserDto[]> {
  return api('/admin/users');
}

export function adminAccounts(): Promise<PlatformAdminAccountDto[]> {
  return api('/admin/accounts');
}

export function adminProjects(): Promise<PlatformAdminProjectDto[]> {
  return api('/admin/projects');
}

export function adminUsage(params: Record<string, string> = {}): Promise<UsageReportDto> {
  const qs = new URLSearchParams(params).toString();
  return api(`/admin/usage${qs ? `?${qs}` : ''}`);
}

export function adminPlans(): Promise<PlatformAdminPlanDto[]> {
  return api('/admin/plans');
}

export function adminAccountEntitlement(accountId: string): Promise<AccountEntitlementDto> {
  return api(`/admin/accounts/${accountId}/entitlement`);
}

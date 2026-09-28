/**
 * Usage read/reporting service (R5.10.8).
 *
 * Reads the append-only usage ledger through the existing `UsageEventStore`
 * aggregate, not a new persistence path. The route authorizes the project/account
 * scope and validates the filter; this service only shapes the report. It never
 * returns raw events (aggregates only) and never derives cost.
 */

import type {
  UsageAggregate,
  UsageCategory,
  UsageReportDto,
  UsageUnit,
} from '@seo/contracts';
import type { UsageEventStore } from './usageEventRepository.js';

/** One authorized, validated usage report request. */
export interface UsageReportRequest {
  actorUserId: string;
  accountId?: string | null;
  projectId?: string | null;
  category?: UsageCategory;
  provider?: string;
  operation?: string;
  unit?: UsageUnit;
  success?: boolean;
  occurredFrom?: string;
  occurredTo?: string;
}

/**
 * Aggregate the ledger for one scope. The store's `aggregate` re-checks the
 * actor's membership in the database RPC, so authorization is defense in depth:
 * the route already gated the scope, the store refuses a scope the actor cannot
 * see.
 */
export async function readUsageReport(
  store: UsageEventStore,
  request: UsageReportRequest,
): Promise<UsageReportDto> {
  const totals: UsageAggregate[] = await store.aggregate({
    actorUserId: request.actorUserId,
    accountId: request.accountId ?? null,
    projectId: request.projectId ?? null,
    category: request.category,
    provider: request.provider,
    operation: request.operation,
    unit: request.unit,
    success: request.success,
    occurredFrom: request.occurredFrom,
    occurredTo: request.occurredTo,
  });
  return {
    scope: {
      accountId: request.accountId ?? null,
      projectId: request.projectId ?? null,
    },
    totals,
  };
}

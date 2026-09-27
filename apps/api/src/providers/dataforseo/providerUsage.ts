/**
 * DataForSEO logical-operation usage accounting (R5.10.4).
 *
 * Counts *logical provider consumption* at the adapter boundary - never raw HTTP
 * traffic. DataForSeoClient.request() does auth, retries, rate limiting and
 * tasks_ready polling; instrumenting that layer would turn one 100-keyword SERP
 * run into dozens of fake "requests". So usage facts are emitted only around the
 * logical operations in DataForSeoDataSource, one fact set per operation:
 *
 *   request       one successful logical provider operation
 *   keyword       keywords submitted to the provider
 *   task          DataForSEO async tasks actually created
 *   serp_request  logical SERP retrievals
 *
 * Emission is best-effort (see R5.10.3): a ledger failure is logged and
 * swallowed so it can never turn a real provider result into a failure.
 */

import {
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderContext,
  type UsageUnit,
} from '@seo/contracts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;
const SOURCE_ID_MAX = 200;

/** One unit of consumption within a logical DataForSEO operation. */
export interface DataForSeoUsageFact {
  operation: string;
  unit: UsageUnit;
  quantity: number;
}

/**
 * Build the append-only events for one logical DataForSEO operation. Returns an
 * empty list when there is no usage context, nothing was consumed, or the scope
 * cannot form a valid event (a malformed event must never be emitted).
 */
export function buildDataForSeoUsageEvents(args: {
  ctx: ProviderContext;
  providerId: string;
  facts: readonly DataForSeoUsageFact[];
  success: boolean;
  metadata?: Record<string, unknown>;
}): NewUsageEvent[] {
  const { ctx, providerId, success } = args;
  const usage = ctx.usage;
  if (!usage) return [];
  if (!UUID_RE.test(ctx.projectId)) return [];
  if (!TOKEN_RE.test(providerId)) return [];

  const sourceId =
    typeof usage.sourceId === 'string' && usage.sourceId.length > 0 && usage.sourceId.length <= SOURCE_ID_MAX
      ? usage.sourceId
      : null;

  const occurrences = new Map<string, number>();
  const events: NewUsageEvent[] = [];
  for (const fact of args.facts) {
    if (!TOKEN_RE.test(fact.operation)) continue;
    if (!Number.isInteger(fact.quantity) || fact.quantity <= 0) continue;
    let occurrence = occurrences.get(fact.operation);
    if (occurrence === undefined) {
      occurrence = usage.nextOccurrence(fact.operation);
      occurrences.set(fact.operation, occurrence);
    }
    events.push({
      accountId: null,
      projectId: ctx.projectId,
      userId: ctx.userId,
      category: 'dataforseo',
      provider: providerId,
      operation: fact.operation,
      quantity: fact.quantity,
      unit: fact.unit,
      success,
      sourceId,
      metadata: args.metadata ?? {},
      idempotencyKey: usageEventIdempotencyKey({
        category: 'dataforseo',
        provider: providerId,
        operation: fact.operation,
        unit: fact.unit,
        sourceId,
        occurrence,
      }),
    });
  }
  return events;
}

/** Best-effort append of one logical operation's usage facts. */
export async function emitDataForSeoUsage(args: {
  ctx: ProviderContext;
  providerId: string;
  facts: readonly DataForSeoUsageFact[];
  success: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const sink = args.ctx.usage?.sink;
  const events = buildDataForSeoUsageEvents(args);
  if (!sink || events.length === 0) return;
  try {
    await sink.append(events);
  } catch (err) {
    args.ctx.logger.error('dataforseo usage event append failed', { err: String(err), events: events.length });
  }
}

/**
 * Append-only usage ledger store (R5.10.2).
 *
 * `seo_usage_events` is the immutable evidence projection defined by
 * `@seo/contracts/usageEvent` (R5.10.1). This is the single persistence seam and
 * it is deliberately append-only: it exposes `append`, `list` and `aggregate`
 * and nothing else. There is no `update`, no `delete` and no generic CRUD, so a
 * usage event can never be mutated through the application domain.
 *
 * It is not a billing table. Cost is derived later from usage facts and pricing
 * rules (`usage event -> pricing rule -> calculated cost`), never stored, so
 * historical usage stays truthful when provider prices change.
 *
 * Idempotency is the DB's job: `append` derives the key from the stable
 * `sourceId` (or takes an explicit override) and treats a unique violation as
 * "already recorded" rather than an error. Retries that genuinely re-call a
 * provider carry a new attempt identity and correctly become new events.
 *
 * Two implementations share this contract: a Supabase (service-role) store used
 * in production and an in-memory store used by tests.
 */

import { randomUUID } from 'node:crypto';
import {
  USAGE_EVENT_IDEMPOTENCY_KEY_MAX_CHARS,
  isValidUsageCategory,
  isValidUsageEvent,
  isValidUsageUnit,
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type UsageAggregate,
  type UsageEvent,
  type UsageEventFilter,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { createAdminClient } from '../supabase.js';

export interface UsageAppendResult {
  inserted: number;
  duplicates: number;
}

/** Aggregation request: a scope plus the verified actor the RPC checks. */
export interface UsageAggregateRequest extends UsageEventFilter {
  actorUserId: string;
}

/**
 * The append-only seam. Read/aggregate callers are responsible for route-level
 * authorization; `aggregate` additionally enforces membership in the DB RPC
 * before returning any row.
 */
export interface UsageEventStore {
  append(events: readonly NewUsageEvent[]): Promise<UsageAppendResult>;
  list(filter: UsageEventFilter): Promise<UsageEvent[]>;
  aggregate(request: UsageAggregateRequest): Promise<UsageAggregate[]>;
}

interface UsageEventColumn {
  id: string;
  occurred_at: string;
  account_id: string | null;
  project_id: string | null;
  user_id: string | null;
  category: string;
  provider: string;
  operation: string;
  quantity: number | string;
  unit: string;
  success: boolean;
  source_id: string | null;
  funding_source: string | null;
  metadata: unknown;
}

interface UsageAggregateColumn {
  category: string;
  provider: string;
  operation: string;
  unit: string;
  quantity: number | string;
  event_count: number | string;
}

interface PreparedEvent {
  event: UsageEvent;
  idempotencyKey: string | null;
}

const SELECT_COLUMNS =
  'id,occurred_at,account_id,project_id,user_id,category,provider,operation,quantity,unit,success,source_id,funding_source,metadata';

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function invalid(where: string, id?: string): never {
  throw new ApiError(500, 'usage_event_state_invalid', 'Persisted usage event is malformed.', {
    ...(id ? { id } : {}),
    where,
  });
}

function internalError(where: string, error: { message?: string }): never {
  logger.error({ err: error?.message }, `seo_usage_events ${where} failed`);
  throw new ApiError(500, 'usage_event_persist_failed', `Usage event ${where} failed.`, {});
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return String(error.code) === '23505' || String(error.message ?? '').toLowerCase().includes('duplicate key');
}

/** Fill defaults, then fail closed: a malformed write is refused, never persisted. */
function prepare(input: NewUsageEvent): PreparedEvent {
  const event: UsageEvent = {
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    category: input.category,
    provider: input.provider,
    operation: input.operation,
    quantity: input.quantity,
    unit: input.unit,
    success: input.success,
    sourceId: input.sourceId,
    fundingSource: input.fundingSource ?? null,
    metadata: input.metadata ?? {},
  };
  const summary = {
    category: event.category,
    provider: event.provider,
    operation: event.operation,
    unit: event.unit,
  };
  if (!isValidUsageEvent(event)) {
    throw new ApiError(500, 'usage_event_invalid', 'Refused to append a malformed usage event.', summary);
  }
  const derived =
    input.idempotencyKey !== undefined
      ? input.idempotencyKey
      : usageEventIdempotencyKey({
          category: event.category,
          provider: event.provider,
          operation: event.operation,
          unit: event.unit,
          sourceId: event.sourceId,
        });
  if (
    derived !== null &&
    (derived.length === 0 || derived.length > USAGE_EVENT_IDEMPOTENCY_KEY_MAX_CHARS)
  ) {
    throw new ApiError(500, 'usage_event_invalid', 'Usage event idempotency key is out of bounds.', {});
  }
  return { event, idempotencyKey: derived };
}

function rowFromColumn(row: UsageEventColumn): UsageEvent {
  const event: UsageEvent = {
    id: row.id,
    occurredAt: row.occurred_at,
    accountId: row.account_id,
    projectId: row.project_id,
    userId: row.user_id,
    category: row.category as UsageEvent['category'],
    provider: row.provider,
    operation: row.operation,
    quantity: toNumber(row.quantity),
    unit: row.unit as UsageEvent['unit'],
    success: row.success,
    sourceId: row.source_id,
    fundingSource: (row.funding_source as UsageEvent['fundingSource']) ?? null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
  if (!isValidUsageEvent(event)) invalid('row', row.id);
  return event;
}

function aggregateFromRow(row: UsageAggregateColumn): UsageAggregate {
  if (!isValidUsageCategory(row.category) || !isValidUsageUnit(row.unit)) {
    throw new ApiError(500, 'usage_event_state_invalid', 'Usage aggregate is malformed.', {
      where: 'aggregate',
    });
  }
  return {
    category: row.category,
    provider: row.provider,
    operation: row.operation,
    unit: row.unit,
    quantity: toNumber(row.quantity),
    eventCount: toNumber(row.event_count),
  };
}

function requireScope(filter: UsageEventFilter): void {
  if (typeof filter.projectId !== 'string' && typeof filter.accountId !== 'string') {
    throw ApiError.badRequest('A project or account scope is required to read usage events');
  }
}

function matches(event: UsageEvent, filter: UsageEventFilter): boolean {
  if (filter.projectId !== undefined && event.projectId !== filter.projectId) return false;
  if (filter.accountId !== undefined && event.accountId !== filter.accountId) return false;
  if (filter.category !== undefined && event.category !== filter.category) return false;
  if (filter.provider !== undefined && event.provider !== filter.provider) return false;
  if (filter.operation !== undefined && event.operation !== filter.operation) return false;
  if (filter.unit !== undefined && event.unit !== filter.unit) return false;
  if (filter.success !== undefined && event.success !== filter.success) return false;
  if (filter.sourceId !== undefined && event.sourceId !== filter.sourceId) return false;
  if (filter.occurredFrom !== undefined && event.occurredAt < filter.occurredFrom) return false;
  if (filter.occurredTo !== undefined && event.occurredAt >= filter.occurredTo) return false;
  return true;
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 200, 500));
}

function compareAggregate(a: UsageAggregate, b: UsageAggregate): number {
  const keys: Array<keyof UsageAggregate> = ['category', 'provider', 'operation', 'unit'];
  for (const key of keys) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/** Production store over the Supabase service-role client. */
export class SupabaseUsageEventStore implements UsageEventStore {
  constructor(private readonly sb: ReturnType<typeof createAdminClient>) {}

  async append(events: readonly NewUsageEvent[]): Promise<UsageAppendResult> {
    let inserted = 0;
    let duplicates = 0;
    for (const input of events) {
      const { event, idempotencyKey } = prepare(input);
      const { error } = await this.sb.from('seo_usage_events').insert({
        id: event.id,
        occurred_at: event.occurredAt,
        account_id: event.accountId,
        project_id: event.projectId,
        user_id: event.userId,
        category: event.category,
        provider: event.provider,
        operation: event.operation,
        quantity: event.quantity,
        unit: event.unit,
        success: event.success,
        source_id: event.sourceId,
        funding_source: event.fundingSource ?? null,
        metadata: event.metadata as never,
        idempotency_key: idempotencyKey,
      });
      if (error) {
        if (isUniqueViolation(error)) {
          duplicates += 1;
          continue;
        }
        internalError('append', error);
      }
      inserted += 1;
    }
    return { inserted, duplicates };
  }

  async list(filter: UsageEventFilter): Promise<UsageEvent[]> {
    requireScope(filter);
    let query = this.sb.from('seo_usage_events').select(SELECT_COLUMNS);
    if (filter.projectId !== undefined) {
      query = filter.projectId === null ? query.is('project_id', null) : query.eq('project_id', filter.projectId);
    }
    if (filter.accountId !== undefined) {
      query = filter.accountId === null ? query.is('account_id', null) : query.eq('account_id', filter.accountId);
    }
    if (filter.category !== undefined) query = query.eq('category', filter.category);
    if (filter.provider !== undefined) query = query.eq('provider', filter.provider);
    if (filter.operation !== undefined) query = query.eq('operation', filter.operation);
    if (filter.unit !== undefined) query = query.eq('unit', filter.unit);
    if (filter.success !== undefined) query = query.eq('success', filter.success);
    if (filter.sourceId !== undefined) query = query.eq('source_id', filter.sourceId);
    if (filter.occurredFrom !== undefined) query = query.gte('occurred_at', filter.occurredFrom);
    if (filter.occurredTo !== undefined) query = query.lt('occurred_at', filter.occurredTo);
    const { data, error } = await query.order('occurred_at', { ascending: false }).limit(clampLimit(filter.limit));
    if (error) internalError('list', error);
    return ((data ?? []) as unknown[]).map((raw) => rowFromColumn(raw as UsageEventColumn));
  }

  async aggregate(request: UsageAggregateRequest): Promise<UsageAggregate[]> {
    requireScope(request);
    const { data, error } = await this.sb.rpc('seo_usage_totals', {
      p_user: request.actorUserId,
      p_project: request.projectId ?? null,
      p_account: request.accountId ?? null,
      p_from: request.occurredFrom ?? null,
      p_to: request.occurredTo ?? null,
      p_category: request.category ?? null,
      p_provider: request.provider ?? null,
      p_operation: request.operation ?? null,
      p_unit: request.unit ?? null,
      p_success: request.success ?? null,
    });
    if (error) {
      if (String(error.code) === '42501') {
        throw ApiError.forbidden('You do not have access to that usage scope');
      }
      internalError('aggregate', error);
    }
    return ((data ?? []) as unknown[]).map((raw) => aggregateFromRow(raw as UsageAggregateColumn));
  }
}

/** In-memory store for tests: same append/idempotency/scope semantics. */
export class InMemoryUsageEventStore implements UsageEventStore {
  private readonly rows: UsageEvent[] = [];
  private readonly keys = new Set<string>();

  async append(events: readonly NewUsageEvent[]): Promise<UsageAppendResult> {
    let inserted = 0;
    let duplicates = 0;
    for (const input of events) {
      const { event, idempotencyKey } = prepare(input);
      const scopeId = event.projectId ?? event.accountId;
      const dedupeKey = idempotencyKey !== null && scopeId !== null ? `${scopeId}:${idempotencyKey}` : null;
      if (dedupeKey !== null && this.keys.has(dedupeKey)) {
        duplicates += 1;
        continue;
      }
      if (dedupeKey !== null) this.keys.add(dedupeKey);
      this.rows.push(event);
      inserted += 1;
    }
    return { inserted, duplicates };
  }

  async list(filter: UsageEventFilter): Promise<UsageEvent[]> {
    requireScope(filter);
    return this.rows
      .filter((event) => matches(event, filter))
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
      .slice(0, clampLimit(filter.limit))
      .map((event) => ({ ...event }));
  }

  async aggregate(request: UsageAggregateRequest): Promise<UsageAggregate[]> {
    requireScope(request);
    const groups = new Map<string, UsageAggregate>();
    for (const event of this.rows) {
      if (!matches(event, request)) continue;
      const key = `${event.category}|${event.provider}|${event.operation}|${event.unit}`;
      const existing = groups.get(key);
      if (existing) {
        existing.quantity += event.quantity;
        existing.eventCount += 1;
      } else {
        groups.set(key, {
          category: event.category,
          provider: event.provider,
          operation: event.operation,
          unit: event.unit,
          quantity: event.quantity,
          eventCount: 1,
        });
      }
    }
    return [...groups.values()].sort(compareAggregate);
  }
}

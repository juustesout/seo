-- ============================================================================
-- SEO Platform - append-only usage ledger (R5.10.2)
--
-- seo_usage_events is the immutable evidence projection of externally consumed
-- resources defined by @seo/contracts/usageEvent (R5.10.1). It is NOT a domain
-- record and NOT a billing table: it stores facts only, never cost, credits,
-- quotas or pricing. Cost is a future derivation (usage event -> pricing rule ->
-- calculated cost), so historical usage stays truthful when provider prices
-- change.
--
-- Append-only invariant:
--   * rows are inserted by the API/worker with the service role after their own
--     access checks; the table has a SELECT-only RLS policy, so browser /
--     PostgREST traffic can read permitted rows but can never insert, update or
--     delete;
--   * there is no updated_at column and no touch trigger - a row is written
--     once;
--   * there is no update/delete policy, and the application never exposes such
--     an operation (the repository seam is append/list/aggregate only).
--
-- Historical immutability: project_id and account_id use ON DELETE SET NULL
-- (not CASCADE). Deleting a project or account must not erase historical usage
-- evidence; the event keeps its fact and only loses its live tenancy link.
-- source_id points at the originating external attempt, so the event is a
-- historical fact that does not change when its source domain record changes or
-- is deleted.
--
-- Idempotency: an event is deduplicatable only when tied to a stable external
-- attempt via source_id. idempotency_key is derived deterministically
-- (v1|category|provider|operation|unit|sourceId|occurrence) and scoped by two
-- partial unique indexes (project scope, account scope). NULL keys are not
-- deduplicated.
-- ============================================================================

create table public.seo_usage_events (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),

  account_id      uuid references public.seo_accounts (id) on delete set null,
  project_id      uuid references public.seo_projects (id) on delete set null,
  user_id         uuid references auth.users (id) on delete set null,

  category        text not null,
  provider        text not null,
  operation       text not null,

  quantity        bigint not null default 0,
  unit            text not null,

  success         boolean not null,

  source_id       text,
  metadata        jsonb not null default '{}'::jsonb,

  idempotency_key text,
  created_at      timestamptz not null default now(),

  constraint seo_usage_events_category_check
    check (category in ('ai', 'dataforseo', 'job', 'publishing', 'media')),
  constraint seo_usage_events_unit_check
    check (unit in ('request', 'task', 'keyword', 'serp_request', 'gsc_request',
                    'input_token', 'output_token', 'image_generation', 'asset',
                    'publish_attempt', 'job')),
  constraint seo_usage_events_quantity_check
    check (quantity >= 0),
  constraint seo_usage_events_provider_format
    check (provider ~ '^[a-z0-9_]{1,64}$'),
  constraint seo_usage_events_operation_format
    check (operation ~ '^[a-z0-9_]{1,64}$'),
  constraint seo_usage_events_source_id_length
    check (source_id is null or char_length(source_id) between 1 and 200),
  constraint seo_usage_events_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint seo_usage_events_idempotency_key_length
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 512)
);

create index seo_usage_events_project_time_idx
  on public.seo_usage_events (project_id, occurred_at desc);
create index seo_usage_events_account_time_idx
  on public.seo_usage_events (account_id, occurred_at desc);
create index seo_usage_events_category_time_idx
  on public.seo_usage_events (category, occurred_at desc);
create index seo_usage_events_source_idx
  on public.seo_usage_events (source_id) where source_id is not null;

-- Two partial uniqueness scopes because project_id and account_id are
-- independently nullable (a single (project_id, account_id, key) index would
-- never dedupe NULL-project rows, as Postgres treats NULLs as distinct). Keys
-- are globally stable per external attempt, so scoped collisions do not occur
-- in practice; a caller-supplied override key must be namespaced by the caller.
create unique index seo_usage_events_project_idem_idx
  on public.seo_usage_events (project_id, idempotency_key)
  where idempotency_key is not null and project_id is not null;
create unique index seo_usage_events_account_idem_idx
  on public.seo_usage_events (account_id, idempotency_key)
  where idempotency_key is not null and project_id is null and account_id is not null;

-- Keep the event attached to its project's account automatically (mirrors the
-- seo_writer_runs / seo_agent_runs pattern): the project row is the
-- authoritative account source, so callers never need to know about accounts.
create or replace function public.seo_usage_events_set_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_id is null and new.project_id is not null then
    select p.account_id into new.account_id
    from public.seo_projects p
    where p.id = new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists seo_usage_events_set_account on public.seo_usage_events;
create trigger seo_usage_events_set_account
  before insert on public.seo_usage_events
  for each row when (new.account_id is null)
  execute function public.seo_usage_events_set_account();

-- ----------------------------------------------------------------------------
-- RLS: read-only for browser/PostgREST; the API/worker write with the service
-- role. There is intentionally no insert/update/delete policy, so historical
-- events cannot be mutated through the application domain.
-- ----------------------------------------------------------------------------

alter table public.seo_usage_events enable row level security;

drop policy if exists seo_usage_events_select on public.seo_usage_events;
create policy seo_usage_events_select on public.seo_usage_events
  for select using (
    (project_id is not null and public.seo_is_member(project_id, auth.uid()))
    or (project_id is null and account_id is not null
        and account_id = public.seo_account_id_for_user(auth.uid()))
    or (project_id is null and account_id is null and user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- Aggregation RPC. Fixed shape - no dynamic SQL and no p_group_by parameter:
-- the only dimensions are category/provider/operation/unit, and the API/UI can
-- regroup further. Membership is enforced before any row is aggregated and the
-- raw ledger is never returned. Only the service role may execute it; the API
-- passes the already-verified actor as p_user (same pattern as
-- seo_ensure_account(p_user)).
-- ----------------------------------------------------------------------------

create or replace function public.seo_usage_totals(
  p_user      uuid,
  p_project   uuid default null,
  p_account   uuid default null,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_category  text default null,
  p_provider  text default null,
  p_operation text default null,
  p_unit      text default null,
  p_success   boolean default null
)
returns table (
  category    text,
  provider    text,
  operation   text,
  unit        text,
  quantity    bigint,
  event_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_project is null and p_account is null then
    raise exception 'A project or account scope is required' using errcode = '22023';
  end if;
  if p_project is not null and not public.seo_is_member(p_project, p_user) then
    raise exception 'Not a member of this project' using errcode = '42501';
  end if;
  if p_account is not null and p_account is distinct from public.seo_account_id_for_user(p_user) then
    raise exception 'Not the owner of this account' using errcode = '42501';
  end if;

  return query
    select e.category, e.provider, e.operation, e.unit,
           coalesce(sum(e.quantity), 0)::bigint as quantity,
           count(*)::bigint as event_count
    from public.seo_usage_events e
    where (p_project is null or e.project_id = p_project)
      and (p_account is null or e.account_id = p_account)
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to is null or e.occurred_at < p_to)
      and (p_category is null or e.category = p_category)
      and (p_provider is null or e.provider = p_provider)
      and (p_operation is null or e.operation = p_operation)
      and (p_unit is null or e.unit = p_unit)
      and (p_success is null or e.success = p_success)
    group by e.category, e.provider, e.operation, e.unit
    order by e.category, e.provider, e.operation, e.unit;
end;
$$;

revoke execute on function public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
) from public;
grant execute on function public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
) to service_role;

-- ============================================================================
-- SEO Platform - background jobs, publishing, audit log.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_sync_jobs - durable background job queue. The worker claims rows with
-- SKIP LOCKED so multiple workers can run concurrently.
-- ----------------------------------------------------------------------------

create table public.seo_sync_jobs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.seo_projects (id) on delete cascade,
  integration_id   uuid references public.seo_integrations (id) on delete set null,
  data_source_id   uuid references public.seo_data_sources (id) on delete set null,
  provider         text not null,
  job_type         text not null,
  status           text not null default 'queued',
  params           jsonb not null default '{}'::jsonb,
  progress         integer not null default 0,
  message          text,
  result           jsonb,
  error            jsonb,
  queued_at        timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  run_after        timestamptz not null default now(),
  retry_count      integer not null default 0,
  max_retries      integer not null default 3,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  idempotency_key  text,
  constraint seo_sync_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  constraint seo_sync_jobs_progress_range check (progress between 0 and 100),
  constraint seo_sync_jobs_retries_nonnegative check (retry_count >= 0 and max_retries >= 0),
  constraint seo_sync_jobs_idempotency_unique unique (idempotency_key)
);

create index seo_sync_jobs_claim_idx on public.seo_sync_jobs (status, run_after, queued_at);
create index seo_sync_jobs_project_created_idx on public.seo_sync_jobs (project_id, created_at desc);
create index seo_sync_jobs_project_status_idx on public.seo_sync_jobs (project_id, status);
create index seo_sync_jobs_job_type_idx on public.seo_sync_jobs (job_type);
create index seo_sync_jobs_created_at_idx on public.seo_sync_jobs (created_at desc);

create trigger seo_sync_jobs_touch_updated_at
  before update on public.seo_sync_jobs
  for each row execute function public.seo_touch_updated_at();

-- Wake the worker whenever a job becomes runnable.
create or replace function public.seo_notify_job_event()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT' and new.status = 'queued') or
     (tg_op = 'UPDATE' and new.status = 'queued' and old.status <> 'queued') then
    perform pg_notify('seo_jobs_channel', new.id::text);
  end if;
  return new;
end;
$$;

create trigger seo_sync_jobs_notify
  after insert or update on public.seo_sync_jobs
  for each row execute function public.seo_notify_job_event();

-- ----------------------------------------------------------------------------
-- seo_publishers
-- ----------------------------------------------------------------------------

create table public.seo_publishers (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  provider      text not null,
  name          text not null,
  config        jsonb not null default '{}'::jsonb,
  status        text not null default 'disconnected',
  capabilities  jsonb not null default '[]'::jsonb,
  last_error    jsonb,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint seo_publishers_status_check
    check (status in ('disconnected', 'connecting', 'connected', 'error', 'disabled')),
  constraint seo_publishers_unique_active
    unique (project_id, provider) deferrable initially immediate
);

create index seo_publishers_project_idx on public.seo_publishers (project_id);
create index seo_publishers_created_at_idx on public.seo_publishers (created_at desc);

create trigger seo_publishers_touch_updated_at
  before update on public.seo_publishers
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_publications - one row per explicit publish/update/delete attempt.
-- ----------------------------------------------------------------------------

create table public.seo_publications (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  publisher_id   uuid not null references public.seo_publishers (id) on delete cascade,
  content_id     uuid references public.seo_content (id) on delete set null,
  status         text not null default 'queued',
  title          text not null,
  slug           text,
  content        text,
  excerpt        text,
  target_url     text,
  remote_id      text,
  error          jsonb,
  scheduled_for  timestamptz,
  published_at   timestamptz,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_publications_status_check
    check (status in ('queued', 'publishing', 'published', 'failed', 'updated', 'deleted', 'scheduled'))
);

-- publisher FK back-reference from seo_credentials (declared earlier).
alter table public.seo_credentials
  add constraint seo_credentials_publisher_fk
  foreign key (publisher_id) references public.seo_publishers (id) on delete cascade;


create index seo_publications_project_idx on public.seo_publications (project_id);
create index seo_publications_publisher_idx on public.seo_publications (publisher_id);
create index seo_publications_status_idx on public.seo_publications (project_id, status);
create index seo_publications_created_at_idx on public.seo_publications (created_at desc);

create trigger seo_publications_touch_updated_at
  before update on public.seo_publications
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_audit_logs - append-only activity trail. Written via DB triggers (so it
-- cannot be forgotten by app code) for the core tables.
-- ----------------------------------------------------------------------------

create table public.seo_audit_logs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.seo_projects (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index seo_audit_logs_project_created_idx on public.seo_audit_logs (project_id, created_at desc);
create index seo_audit_logs_user_idx on public.seo_audit_logs (user_id);
create index seo_audit_logs_entity_idx on public.seo_audit_logs (entity_type, entity_id);

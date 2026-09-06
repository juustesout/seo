-- ============================================================================
-- SEO Platform - content scheduling core (Content Studio Phase H1)
--
-- A schedule is a *planning* entity: it records an intention to publish a
-- content item through a project publisher at an absolute UTC timestamp. It
-- does not execute anything itself. Exactly one existing `publish` job is
-- created per schedule (run_after = scheduled_at, deterministic idempotency
-- key `schedule:<id>:publish`); retries stay the responsibility of the job
-- infrastructure. seo_schedules.status is a read model synchronized from the
-- backing job + publication outcome - never a second source of truth.
--
-- seo_publications gains a nullable schedule_id link so the trace
-- schedule -> job -> publication attempts is queryable without a new table or
-- a payload redesign.
-- ============================================================================

create table public.seo_schedules (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  content_id    uuid not null references public.seo_content (id) on delete cascade,
  publisher_id  uuid not null references public.seo_publishers (id) on delete cascade,
  scheduled_at  timestamptz not null,
  status        text not null default 'scheduled',
  job_id        uuid references public.seo_sync_jobs (id) on delete set null,
  created_by    uuid not null references auth.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  constraint seo_schedules_status_check
    check (status in ('scheduled', 'queued', 'publishing', 'published', 'failed', 'cancelled'))
);

create index seo_schedules_project_scheduled_idx on public.seo_schedules (project_id, scheduled_at);
create index seo_schedules_content_idx on public.seo_schedules (content_id);
create index seo_schedules_publisher_idx on public.seo_schedules (publisher_id);
create index seo_schedules_job_idx on public.seo_schedules (job_id);
create index seo_schedules_status_idx on public.seo_schedules (project_id, status);

create trigger seo_schedules_touch_updated_at
  before update on public.seo_schedules
  for each row execute function public.seo_touch_updated_at();

-- Trace schedule -> publication attempts (additive only; existing publication
-- columns and publishing behavior are untouched).
alter table public.seo_publications
  add column schedule_id uuid references public.seo_schedules (id) on delete set null;

create index seo_publications_schedule_idx on public.seo_publications (schedule_id);

-- ----------------------------------------------------------------------------
-- RLS. The API writes with the service role (bypasses RLS after its own access
-- checks); these policies are the boundary for any browser-side / PostgREST
-- traffic: members read schedules, editors+ create/reschedule/cancel them.
-- Schedules are never hard-deleted (DELETE = cancel), so no delete policy.
-- ----------------------------------------------------------------------------

alter table public.seo_schedules enable row level security;

drop policy if exists seo_schedules_select on public.seo_schedules;
create policy seo_schedules_select on public.seo_schedules
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_schedules_insert on public.seo_schedules;
create policy seo_schedules_insert on public.seo_schedules
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_schedules_update on public.seo_schedules;
create policy seo_schedules_update on public.seo_schedules
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

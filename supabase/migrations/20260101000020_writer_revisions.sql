-- ============================================================================
-- SEO Platform - writer revision loop (Writer W8)
--
-- W7 defined seo_writer_runs.status with a fixed CHECK vocabulary. W8 turns a
-- fully written run's post-review state into a controlled revision loop: the
-- deterministic review rests the run on `review_ready` and an explicit, human
-- revise resumes the SAME thread through `revising` (async, observable: one AI
-- rewrite per requested section, each persisted as its own superstep) and
-- `reviewing` (the synchronous deterministic re-review that flows straight back
-- to `review_ready`). The status CHECK is therefore widened with `revising` and
-- `reviewing`; `review_ready` is a resting (non-terminal) state, while
-- `completed` stays terminal and is only reached through an explicit accept
-- (not exposed by the W8 API surface).
--
-- The revision counters are kept as derived columns for observability in the
-- SQL console; the validated source of truth for both counters and the pending
-- revision request is the run's state_json snapshot (which the repository
-- writes on every transition).
-- ============================================================================

alter table public.seo_writer_runs drop constraint seo_writer_runs_status_check;

alter table public.seo_writer_runs
  add constraint seo_writer_runs_status_check
  check (status in ('starting', 'gathering_context', 'planning',
                    'awaiting_approval', 'writing', 'reviewing', 'revising',
                    'review_ready', 'completed', 'rejected', 'failed'));

-- Observability-only derived counters (source of truth: state_json snapshot).
alter table public.seo_writer_runs add column if not exists revision_count integer not null default 0;
alter table public.seo_writer_runs add column if not exists last_revision_at timestamptz;

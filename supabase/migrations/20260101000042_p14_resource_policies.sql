-- ============================================================================
-- SEO Platform - concrete product resource policies (P14)
--
-- P13 created the generic entitlement engine; P14 configures it with the first
-- concrete Old Skool SEO baseline. This migration adds no new tables: the P13
-- schema already models plans, resource policies, bindings and reservations.
-- It only aligns the seeded base-plan policies with the canonical registry
-- (packages/contracts/src/entitlement.ts, ENTITLEMENT_RESOURCE_SPEC) so the
-- stored rows, the read model, the UI and enforcement all read the same units.
--
-- Policy semantics are unchanged from P13:
--   allowance is null  -> no product cap (technical P9/P11 ceiling only)
--   allowance = 0      -> not included on this plan
--
-- The one resource with a real, per-unit operator cost that must not be given
-- away unlimited is `x_link_post` (X bills ~EUR0.20 for a post carrying a link).
-- It stays at 0 on the base plan. Every other operator-funded resource stays
-- uncapped: P12 left their commercial ceilings undecided, and P14 deliberately
-- does not fabricate a number. The line between operator cost and customer
-- price is kept clean; future billing can attach a price without a schema or
-- engine change. See docs/p14-resource-policies.md.
--
-- Idempotent and re-runnable.
-- ============================================================================

insert into public.seo_resource_policies
  (plan_id, resource, unit, period, scope, operator_funded, byok_exempt, status, allowance)
select p.id, v.resource, v.unit, 'month', 'account', v.operator_funded, v.byok_exempt, 'active', v.allowance
from public.seo_plans p
cross join (values
  ('ai_generation',       'tokens',     true,  true,  null::integer),
  ('ai_image',            'images',     true,  true,  null),
  ('dataforseo_research', 'requests',   true,  true,  null),
  ('media',               'searches',   true,  false, null),
  ('x_link_post',         'link_posts', true,  false, 0)
) as v(resource, unit, operator_funded, byok_exempt, allowance)
where p.key = 'base'
on conflict (plan_id, resource) do update
  set unit            = excluded.unit,
      period          = excluded.period,
      scope           = excluded.scope,
      operator_funded = excluded.operator_funded,
      byok_exempt     = excluded.byok_exempt,
      status          = excluded.status,
      allowance       = excluded.allowance,
      updated_at      = now();

comment on table public.seo_resource_policies is
  'P13/P14 plan -> operator-funded resource allowance. allowance NULL = no product cap; 0 = not included. Units are the canonical registry labels (ENTITLEMENT_RESOURCE_SPEC). Product policy only: no prices.';

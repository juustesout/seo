-- ============================================================================
-- SEO Platform - customer plans & pricing model (P15)
--
-- P13 built the entitlement engine and P14 configured concrete resource
-- policies. P15 adds the *customer-facing commercial catalog* on top of the
-- same engine: plan identity, ordering, visibility, feature packaging and
-- pricing/billing metadata. It adds NO billing logic - no payments, invoices,
-- subscriptions, renewal, grace periods or provider charges. The pricing
-- columns only state what a plan is offered at for display; enforcement still
-- flows through the P13/P14 entitlement admission path unchanged.
--
-- Amounts are integer minor units (EUR 19.00 -> 1900), never floating point.
-- A null price/allowance means the value is a still-open product decision; the
-- plan's price_status marks whether its price is a draft. See
-- docs/p15-plans-pricing.md.
--
-- Safe default: the default plan ("Free") must not hand out unlimited
-- operator-funded capacity. P14 left the default's AI/DataForSEO/media
-- allowances uncapped (null) because the commercial ceiling was undecided; P15
-- replaces that with an explicit 0 ("hosted not included") so no account gets
-- accidental unlimited hosted spend. The concrete free-tier hosted amounts
-- remain an open product decision (see the comment below). BYOK is unaffected:
-- ai_generation/ai_image/dataforseo_research are byok_exempt, so a user's own
-- key still works on the free plan.
--
-- The paid tiers are seeded as *internal drafts* (is_public false, status
-- disabled, no pricing): P12 section 23 ("do not invent Free/Pro/Agency") and
-- P15 section 3 ("do not invent prices") forbid fabricating their values, so
-- they exist only to show the catalog can express them. They cannot be assigned
-- while disabled and are never shown to customers.
--
-- Idempotent and re-runnable.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Catalog + pricing columns on seo_plans.
-- ----------------------------------------------------------------------------
alter table public.seo_plans
  add column if not exists display_name      text,
  add column if not exists sort_order        integer not null default 0,
  add column if not exists is_public         boolean not null default true,
  add column if not exists currency          text,
  add column if not exists monthly_price     integer,
  add column if not exists yearly_price      integer,
  add column if not exists price_status      text not null default 'draft',
  add column if not exists price_label       text,
  add column if not exists billing_intervals text[] not null default array['monthly', 'yearly']::text[];

-- Backfill the customer-facing name for any pre-existing plan, then require it.
update public.seo_plans set display_name = name where display_name is null;

alter table public.seo_plans alter column display_name set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_display_name_length') then
    alter table public.seo_plans
      add constraint seo_plans_display_name_length check (char_length(btrim(display_name)) between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_sort_order_check') then
    alter table public.seo_plans add constraint seo_plans_sort_order_check check (sort_order >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_currency_check') then
    alter table public.seo_plans add constraint seo_plans_currency_check check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_monthly_price_check') then
    alter table public.seo_plans add constraint seo_plans_monthly_price_check check (monthly_price is null or monthly_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_yearly_price_check') then
    alter table public.seo_plans add constraint seo_plans_yearly_price_check check (yearly_price is null or yearly_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_price_status_check') then
    alter table public.seo_plans add constraint seo_plans_price_status_check check (price_status in ('draft', 'final'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_price_label_length') then
    alter table public.seo_plans
      add constraint seo_plans_price_label_length check (price_label is null or char_length(btrim(price_label)) between 1 and 40);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seo_plans_billing_intervals_check') then
    alter table public.seo_plans
      add constraint seo_plans_billing_intervals_check
      check (billing_intervals <@ array['monthly', 'yearly']::text[] and cardinality(billing_intervals) >= 1);
  end if;
end $$;

comment on column public.seo_plans.display_name is
  'P15 customer-facing plan name (name stays the internal label).';
comment on column public.seo_plans.is_public is
  'P15: whether the plan is shown in the customer catalog. Internal/draft plans stay hidden.';
comment on column public.seo_plans.monthly_price is
  'P15 commercial monthly price in integer minor units (1900 = EUR 19.00). NULL = undecided. Display metadata only, never billing.';
comment on column public.seo_plans.yearly_price is
  'P15 commercial yearly price in integer minor units. NULL = undecided. Display metadata only, never billing.';
comment on column public.seo_plans.price_status is
  'P15: draft = provisional product decision, final = decided price.';
comment on column public.seo_plans.billing_intervals is
  'P15 intervals the plan is offered on (monthly/yearly). Product metadata only; no subscription lifecycle.';

-- ----------------------------------------------------------------------------
-- Default plan: customer identity + safe (non-unlimited) hosted allowance.
-- ----------------------------------------------------------------------------
update public.seo_plans
   set display_name      = 'Free',
       is_public         = true,
       sort_order        = 0,
       currency          = null,
       monthly_price     = 0,
       yearly_price      = 0,
       price_status      = 'final',
       price_label       = 'Free',
       billing_intervals = array['monthly', 'yearly']::text[],
       updated_at        = now()
 where key = 'base';

-- Hosted resources are not included on the default plan (allowance 0). This is
-- the safe placeholder: a concrete free-tier amount is an open product decision
-- and must be set deliberately, never by leaving the default uncapped.
update public.seo_resource_policies rp
   set allowance = 0, updated_at = now()
  from public.seo_plans p
 where rp.plan_id = p.id
   and p.key = 'base'
   and rp.resource in ('ai_generation', 'ai_image', 'dataforseo_research', 'media');

-- ----------------------------------------------------------------------------
-- Draft commercial tiers: structure only, no invented values.
-- ----------------------------------------------------------------------------
insert into public.seo_plans
  (key, name, display_name, description, is_default, status, is_public, sort_order, price_status, billing_intervals)
values
  ('starter', 'Starter', 'Starter',
   'Draft commercial plan. Pricing and included hosted amounts are an open product decision.',
   false, 'disabled', false, 10, 'draft', array['monthly', 'yearly']::text[]),
  ('pro', 'Pro', 'Pro',
   'Draft commercial plan. Pricing and included hosted amounts are an open product decision.',
   false, 'disabled', false, 20, 'draft', array['monthly', 'yearly']::text[]),
  ('agency', 'Agency', 'Agency',
   'Draft commercial plan. Pricing and included hosted amounts are an open product decision.',
   false, 'disabled', false, 30, 'draft', array['monthly', 'yearly']::text[])
on conflict (key) do nothing;

insert into public.seo_plan_features (plan_id, feature, enabled)
select p.id, f.feature, true
from public.seo_plans p
cross join (values ('api_access'), ('mcp_access'), ('ai_editing'), ('publishing'), ('designer'), ('composer')) as f(feature)
where p.key in ('starter', 'pro', 'agency')
on conflict (plan_id, feature) do nothing;

-- ----------------------------------------------------------------------------
-- Platform-admin plan read now exposes the catalog/pricing metadata.
-- ----------------------------------------------------------------------------
drop function if exists public.seo_platform_admin_plans(uuid);

create function public.seo_platform_admin_plans(p_actor uuid)
returns table (
  key               text,
  name              text,
  display_name      text,
  description       text,
  is_default        boolean,
  is_public         boolean,
  sort_order        integer,
  status            text,
  currency          text,
  monthly_price     integer,
  yearly_price      integer,
  price_status      text,
  price_label       text,
  billing_intervals text[],
  features          text[],
  allowance_count   bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select p.key,
           p.name,
           p.display_name,
           p.description,
           p.is_default,
           p.is_public,
           p.sort_order,
           p.status,
           p.currency,
           p.monthly_price,
           p.yearly_price,
           p.price_status,
           p.price_label,
           p.billing_intervals,
           coalesce(
             array_agg(f.feature order by f.feature) filter (where f.enabled),
             '{}'
           )::text[] as features,
           (select count(*) from public.seo_resource_policies rp where rp.plan_id = p.id)::bigint
    from public.seo_plans p
    left join public.seo_plan_features f on f.plan_id = p.id
    group by p.id, p.key, p.name, p.display_name, p.description, p.is_default,
             p.is_public, p.sort_order, p.status, p.currency, p.monthly_price,
             p.yearly_price, p.price_status, p.price_label, p.billing_intervals
    order by p.sort_order, p.is_default desc, p.key;
end;
$$;

revoke execute on function public.seo_platform_admin_plans(uuid) from public, anon, authenticated;
grant execute on function public.seo_platform_admin_plans(uuid) to service_role;

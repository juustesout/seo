-- ============================================================================
-- SEO Platform - dashboard summary RPC.
-- Single, security-definer aggregate query used by the project dashboard.
-- Caller membership is verified first; then real stored data is aggregated.
-- Returns JSON so the shape can evolve without schema churn.
-- ============================================================================

create or replace function public.seo_dashboard_summary(p_project uuid, p_range_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_prev_start date;
  v_end date;
  v_overview jsonb;
  v_trends jsonb;
  v_top_queries jsonb;
  v_top_pages jsonb;
  v_keyword_stats jsonb;
  v_sync jsonb;
  v_activity jsonb;
  v_audits jsonb;
  v_clicks bigint;
  v_impressions bigint;
  v_position numeric;
  v_prev_clicks bigint;
  v_prev_impressions bigint;
  v_prev_position numeric;
begin
  if not public.seo_is_member(p_project, auth.uid()) then
    raise exception 'Not a member of this project' using errcode = '42501';
  end if;

  v_end := current_date;
  v_start := v_end - (p_range_days - 1);
  v_prev_start := v_start - p_range_days;
  v_prev_position := null;

  -- Current period totals
  select coalesce(sum(clicks), 0), coalesce(sum(impressions), 0), coalesce(avg(position), 0)
    into v_clicks, v_impressions, v_position
  from public.seo_gsc_performance
  where project_id = p_project and date between v_start and v_end;

  -- Previous equal-length period totals
  select coalesce(sum(clicks), 0), coalesce(sum(impressions), 0), coalesce(avg(position), 0)
    into v_prev_clicks, v_prev_impressions, v_prev_position
  from public.seo_gsc_performance
  where project_id = p_project and date between v_prev_start and (v_start - 1);

  v_overview := jsonb_build_object(
    'clicks', v_clicks,
    'impressions', v_impressions,
    'ctr', case when v_impressions > 0 then round((v_clicks::numeric / v_impressions) * 100, 2) else 0 end,
    'position', round(v_position::numeric, 1),
    'clicks_trend', case when v_prev_clicks > 0 then round(((v_clicks - v_prev_clicks)::numeric / v_prev_clicks) * 100, 1) else null end,
    'impressions_trend', case when v_prev_impressions > 0 then round(((v_impressions - v_prev_impressions)::numeric / v_prev_impressions) * 100, 1) else null end,
    'position_trend', case when v_prev_position is not null and v_prev_position > 0 and v_position > 0 then round((v_prev_position - v_position)::numeric, 1) else null end
  );

  -- Daily trends
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(date, 'YYYY-MM-DD'),
           'clicks', clicks, 'impressions', impressions,
           'ctr', round(ctr * 100, 2), 'position', round(position, 1))
           order by date), '[]'::jsonb)
    into v_trends
  from public.seo_gsc_performance
  where project_id = p_project and date between v_start and v_end;

  -- Top queries (with previous-period comparison for trend/opportunities)
  select coalesce(jsonb_agg(t order by t.clicks desc), '[]'::jsonb)
    into v_top_queries
  from (
    select
      q.query,
      sum(q.clicks) as clicks,
      sum(q.impressions) as impressions,
      case when sum(q.impressions) > 0 then round((sum(q.clicks)::numeric / sum(q.impressions)) * 100, 2) else 0 end as ctr,
      round(avg(q.position)::numeric, 1) as position,
      coalesce(p.prev_clicks, 0) as prev_clicks
    from public.seo_gsc_queries q
    left join (
      select query, sum(clicks) as prev_clicks
      from public.seo_gsc_queries
      where project_id = p_project and date between v_prev_start and (v_start - 1)
      group by query
    ) p on p.query = q.query
    where q.project_id = p_project and q.date between v_start and v_end
    group by q.query, p.prev_clicks
    order by sum(q.clicks) desc
    limit 20
  ) t;

  -- Top pages
  select coalesce(jsonb_agg(t order by t.clicks desc), '[]'::jsonb)
    into v_top_pages
  from (
    select
      url,
      sum(clicks) as clicks,
      sum(impressions) as impressions,
      case when sum(impressions) > 0 then round((sum(clicks)::numeric / sum(impressions)) * 100, 2) else 0 end as ctr,
      round(avg(position)::numeric, 1) as position
    from public.seo_gsc_pages
    where project_id = p_project and date between v_start and v_end
    group by url
    order by sum(clicks) desc
    limit 10
  ) t;

  -- Keyword pool statistics
  select jsonb_build_object(
      'total', (select count(*) from public.seo_keywords where project_id = p_project),
      'gsc_queries_90d', (select count(distinct query) from public.seo_gsc_queries where project_id = p_project and date >= current_date - 90),
      'top10', (select count(*) from (
          select query from public.seo_gsc_queries
          where project_id = p_project and date >= current_date - 90
          group by query
          having round(avg(position)::numeric, 1) <= 10
      ) x),
      'top3', (select count(*) from (
          select query from public.seo_gsc_queries
          where project_id = p_project and date >= current_date - 90
          group by query
          having round(avg(position)::numeric, 1) <= 3
      ) y)
    )
    into v_keyword_stats;

  -- Sync / job status
  select jsonb_build_object(
      'last_sync_at', (select max(last_synced_at) from public.seo_data_sources where project_id = p_project),
      'active_jobs', (select count(*) from public.seo_sync_jobs where project_id = p_project and status in ('queued', 'running')),
      'failed_jobs', (select count(*) from public.seo_sync_jobs where project_id = p_project and status = 'failed' and completed_at >= now() - interval '24 hours')
    )
    into v_sync;

  -- Audit summary + top issues
  select jsonb_build_object(
      'critical', (select count(*) from public.seo_audits where project_id = p_project and severity = 'critical'),
      'warning', (select count(*) from public.seo_audits where project_id = p_project and severity = 'warning'),
      'info', (select count(*) from public.seo_audits where project_id = p_project and severity = 'info'),
      'recent', coalesce((
        select jsonb_agg(jsonb_build_object('title', title, 'severity', severity, 'url', url, 'finding_key', finding_key, 'audited_at', audited_at))
        from (
          select title, severity, url, finding_key, audited_at
          from public.seo_audits
          where project_id = p_project
          order by audited_at desc
          limit 5
        ) a
      ), '[]'::jsonb)
    )
    into v_audits;

  -- Recent activity
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'action', action, 'entity_type', entity_type,
           'entity_id', entity_id, 'created_at', created_at, 'meta', meta)
           order by created_at desc), '[]'::jsonb)
    into v_activity
  from (
    select id, action, entity_type, entity_id, created_at, meta
    from public.seo_audit_logs
    where project_id = p_project
    order by created_at desc
    limit 10
  ) act;

  return jsonb_build_object(
    'overview', v_overview,
    'trends', v_trends,
    'topQueries', v_top_queries,
    'topPages', v_top_pages,
    'keywordStats', v_keyword_stats,
    'sync', v_sync,
    'audits', v_audits,
    'recentActivity', v_activity
  );
end;
$$;

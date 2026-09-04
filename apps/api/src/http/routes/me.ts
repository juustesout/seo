/** GET /api/me - current user + the projects they belong to (with live counts). */

import { Router } from 'express';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import type { MeDto } from '@seo/contracts';

export const meRouter: Router = Router();

meRouter.use(requireAuth);

async function countRows(
  container: { sb: import('@supabase/supabase-js').SupabaseClient },
  table: string,
  projectId: string,
  extra?: { eq?: [string, string] },
): Promise<number> {
  let q = container.sb.from(table as never).select('id', { count: 'exact', head: true }).eq('project_id', projectId);
  if (extra?.eq) q = q.eq(extra.eq[0], extra.eq[1]);
  const { count } = await q;
  return count ?? 0;
}

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { container, user } = req;
    const userId = user!.sub;

    const { data: memberships, error: membershipsError } = await container.sb
      .from('seo_project_members')
      .select('project_id, role')
      .eq('user_id', userId);
    if (membershipsError) throw membershipsError;

    const projects: MeDto['projects'] = [];
    const projectIds = (memberships ?? []).map((m) => m.project_id as string);

    if (projectIds.length > 0) {
      const { data: projectsData, error } = await container.sb
        .from('seo_projects')
        .select('*')
        .in('id', projectIds);
      if (error) throw error;
      const roleMap = new Map(memberships!.map((m) => [m.project_id as string, m.role as string]));

      for (const p of projectsData ?? []) {
        const id = p.id as string;
        const [memberCount, domainCount, integrationCount, connectedCount, jobCount] = await Promise.all([
          countRows(container, 'seo_project_members', id),
          countRows(container, 'seo_domains', id),
          countRows(container, 'seo_integrations', id),
          countRows(container, 'seo_integrations', id, { eq: ['status', 'connected'] }),
          countRows(container, 'seo_sync_jobs', id),
        ]);
        const { data: lastSync } = await container.sb
          .from('seo_data_sources')
          .select('last_synced_at')
          .eq('project_id', id)
          .not('last_synced_at', 'is', null)
          .order('last_synced_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        projects.push({
          id,
          name: p.name as string,
          slug: (p.slug as string | null) ?? null,
          description: (p.description as string | null) ?? null,
          website_url: (p.website_url as string | null) ?? null,
          timezone: (p.timezone as string) ?? 'UTC',
          settings: (p.settings as Record<string, unknown>) ?? {},
          created_by: p.created_by as string,
          created_at: p.created_at as string,
          updated_at: p.updated_at as string,
          role: (roleMap.get(id) ?? 'viewer') as MeDto['projects'][number]['role'],
          member_count: memberCount,
          domain_count: domainCount,
          integration_count: integrationCount,
          connected_count: connectedCount,
          job_count: jobCount,
          last_sync_at: (lastSync?.last_synced_at as string | null) ?? null,
        });
      }
    }

    const dto: MeDto = { user_id: userId, email: user!.email ?? null, projects };
    res.json({ data: dto });
  }),
);

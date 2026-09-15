/**
 * Shared accessor for the `seo_projects.settings` JSON bag.
 *
 * Several project-scoped, non-secret preferences live in one jsonb column
 * (`settings.ai`, `settings.coreTopics`, `settings.cosmos`, ...). Reading the
 * bag, merging one key and writing it back must preserve every sibling key, so
 * that logic lives here once instead of being re-implemented per feature.
 */

import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';

/** Read the project's settings bag. 404s when the project does not exist. */
export async function readProjectSettings(
  container: ServiceContainer,
  projectId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await container.sb
    .from('seo_projects')
    .select('settings')
    .eq('id', projectId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the project settings');
  if (!data) throw ApiError.notFound('Project not found');
  return data.settings ?? {};
}

/**
 * Merge one or more keys into the project's settings bag, preserving every
 * other key. Returns the resulting bag.
 */
export async function writeProjectSettings(
  container: ServiceContainer,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const settings = await readProjectSettings(container, projectId);
  const next = { ...settings, ...patch };
  const { error } = await container.sb
    .from('seo_projects')
    .update({ settings: next } as never)
    .eq('id', projectId);
  if (error) throw new ApiError(400, 'bad_request', 'Could not update the project settings');
  return next;
}

/**
 * Readiness probe. Distinct from liveness (/api/health, which only proves the
 * process is up): readiness proves the API can actually serve project-scoped
 * work, i.e. the system of record is reachable. The deploy gate uses this so a
 * release is only promoted once the database answers, and a bad release rolls
 * back instead of serving 500s.
 *
 * The check is intentionally a single cheap query: it detects connectivity and
 * auth failures without depending on any feature table being populated.
 */

import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';

export async function checkReadiness(container: ServiceContainer): Promise<void> {
  if (container.pgPool) {
    try {
      await container.pgPool.query('select 1');
      return;
    } catch (err) {
      logger.error({ err }, 'readiness: direct postgres ping failed');
      throw new ApiError(503, 'not_ready', 'Database is not reachable');
    }
  }
  const { error } = await container.sb.from('seo_projects').select('id').limit(1);
  if (error) {
    // Raw driver error is logged, never returned: readiness responses are
    // reachable by the load balancer and must not disclose internals.
    logger.error({ error }, 'readiness: supabase ping failed');
    throw new ApiError(503, 'not_ready', 'Database is not reachable');
  }
}

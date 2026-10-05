/**
 * Endpoint-class rate-limit tiers.
 *
 * The two global limiters in `app.ts` bound every request per identity. On top
 * of those, this module tightens three classes of request whose cost is not
 * proportional to their count:
 *
 *   - `strict`    credential minting / OAuth token exchange (all methods),
 *   - `expensive` mutating provider work (AI compose, research, sync, upload),
 *   - `moderate`  job/publication/schedule enqueueing.
 *
 * Class tiers never replace the global tiers - they only add a tighter bucket
 * on top, so a request to a class prefix must pass both. Read-only GETs on the
 * hot `expensive`/`moderate` prefixes stay on the generous global budget
 * (these routes are polled while a job runs); only the mutating methods that
 * actually spend money/quota are counted here. This is also why the tiers are
 * mounted before the raw body parsers: a rejected upload is never buffered.
 *
 * One limiter instance per class means the budget is shared across every
 * prefix in that class (30 expensive calls/min total, not per endpoint), which
 * is the intended per-operation guard. Like the global limiters these are
 * process-local; see `rateLimit.ts` for the scaling note.
 */
import type { Express } from 'express';
import { createRateLimiter } from './rateLimit.js';
import type { AppConfig } from '../config.js';

/** Methods that mutate state or trigger provider work (GET/HEAD read only). */
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface ClassTier {
  name: string;
  max: number;
  prefixes: string[];
  /** When set, only these methods are counted; others pass through. */
  methods?: readonly string[];
}

/**
 * Mount the three class tiers onto `app`. Call after `optionalAuth` (so the
 * bucket keys on the authenticated user, falling back to IP) and before any
 * raw body parser or route.
 */
export function mountClassRateLimits(app: Express, rateLimit: AppConfig['rateLimit']): void {
  if (rateLimit.disabled) return;

  const tiers: ClassTier[] = [
    {
      name: 'strict',
      max: rateLimit.strictMax,
      // OAuth start/callback are GET and API-key reads are cheap but rare, so
      // the whole prefix is bounded (there is no costly write to isolate).
      prefixes: [
        '/api/oauth',
        '/api/account/api-keys',
        '/api/projects/:projectId/api-keys',
      ],
    },
    {
      name: 'expensive',
      max: rateLimit.expensiveMax,
      methods: MUTATING_METHODS,
      // `/content` covers the writer/designer sub-routes mounted beneath it.
      // `/mcp` is a streamable-HTTP POST surface that can run synchronous AI
      // (Designer) so it shares the expensive budget; `/integrations` and
      // `/publishers` `/test` endpoints probe external providers.
      prefixes: [
        '/api/projects/:projectId/keyword',
        '/api/projects/:projectId/composition',
        '/api/projects/:projectId/designer',
        '/api/projects/:projectId/content',
        '/api/projects/:projectId/knowledge',
        '/api/projects/:projectId/gsc',
        '/api/projects/:projectId/analytics',
        '/api/projects/:projectId/media',
        '/api/projects/:projectId/integrations',
        '/api/projects/:projectId/publishers',
        '/api/mcp',
      ],
    },
    {
      name: 'moderate',
      max: rateLimit.moderateMax,
      methods: MUTATING_METHODS,
      // `/v1` is the project-API-key REST surface; enqueueing is already bounded
      // by P9 admission, this bounds the mutating request rate behind the key.
      prefixes: [
        '/api/projects/:projectId/jobs',
        '/api/projects/:projectId/publications',
        '/api/projects/:projectId/schedules',
        '/api/projects/:projectId/performance',
        '/api/v1',
      ],
    },
  ];

  for (const tier of tiers) {
    const limiter = createRateLimiter({
      windowMs: rateLimit.windowMs,
      max: tier.max,
      name: tier.name,
      methods: tier.methods,
    });
    for (const prefix of tier.prefixes) {
      app.use(prefix, limiter);
    }
  }
}

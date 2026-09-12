/**
 * Express application assembly. Mounts the capability catalog, user + project
 * data, integrations, publishers/publications, knowledge, jobs and the SEO
 * data read API under a single /api namespace.
 *
 * Why everything sits under /api: the browser talks to the same origin through
 * the Vite dev proxy and the deployed app terminates TLS in front of one
 * port, so one namespace is the contract between web and API. Why mounting
 * order matters: resolveContainer + optionalAuth run before every route so all
 * handlers downstream can rely on req.container and req.user; unauthenticated
 * paths (health, the Google OAuth callback which is a browser redirect) are
 * mounted early and deliberately skip any guard; project-scoped routers hang
 * off /api/projects/:projectId so the project id is a path parameter, and each
 * of them authorizes per-route via container.access.requireRole. The media
 * router parses only raw image bodies (never JSON) so the global 1mb JSON body
 * limit does not constrain file uploads, which have their own 12mb raw limit.
 *
 * Auth is optional at the app level; every route decides its own guard. The
 * terminal notFound + errorHandler run last so any unmatched /api path and any
 * thrown error share one consistent wire shape.
 */

import express from 'express';
import type { Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from './config.js';
import { resolveContainer, optionalAuth } from './http/middleware.js';
import { errorHandler, notFoundHandler } from './apiErrors.js';

import { meRouter } from './http/routes/me.js';
import { accountRouter } from './http/routes/account.js';
import { accountApiKeysRouter } from './http/routes/accountApiKeys.js';
import { accountAiRouter } from './http/routes/accountAi.js';
import { catalogRouter } from './http/routes/catalog.js';
import { oauthRouter } from './http/routes/oauth.js';
import { integrationsRouter } from './http/routes/integrations.js';
import { publishersRouter } from './http/routes/publishers.js';
import { publicationsRouter } from './http/routes/publications.js';
import { schedulesRouter } from './http/routes/schedules.js';
import { knowledgeRouter } from './http/routes/knowledge.js';
import { aiSettingsRouter } from './http/routes/aiSettings.js';
import { contentRouter } from './http/routes/content.js';
import { writerRouter } from './http/routes/writer.js';
import { mediaRouter } from './http/routes/media.js';
import { jobsRouter } from './http/routes/jobs.js';
import { seoRouter } from './http/routes/seo.js';
import { projectApiKeysRouter } from './http/routes/projectApiKeys.js';
import { projectGscRouter } from './http/routes/projectGsc.js';
import { v1Router } from './http/routes/v1.js';
import { createMcpHttpRouter } from './mcp/http.js';

/**
 * Assemble and return the configured Express app. Pure construction with no
 * side effects - listening happens in index.ts so tests can mount the app
 * in-process. trust proxy is enabled so req.ip/req.protocol reflect the real
 * client behind the reverse proxy that terminates TLS; x-powered-by is
 * stripped so responses do not advertise the framework. CORS is handled by an
 * inline middleware that mirrors the request origin only when it is in the
 * allow-list (the public app URL plus any CORS_ORIGINS), answers OPTIONS
 * preflights with 204 and otherwise lets the request through (curl, server-to-
 * server and same-origin traffic carry no Origin header).
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const config = loadConfig();
  const corsOrigins = [config.publicAppUrl, ...config.env.CORS_ORIGINS.split(',').map((s) => s.trim())].filter(
    (o): o is string => Boolean(o),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin && (corsOrigins.length === 0 || corsOrigins.includes(origin))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-client-info, apikey');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // -- unauthenticated ------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'seo-api',
      configured: {
        supabase: config.supabaseConfigured,
        google: config.googleConfigured,
        dataforseo: config.dataforseoConfigured,
        qdrant: config.qdrantConfigured,
        ai: config.aiConfigured,
        credentials_encryption: config.encryptionConfigured,
      },
    });
  });

  // -- container + identity (app level) ------------------------------------
  app.use(resolveContainer);
  app.use(optionalAuth);

  // Google OAuth callback is intentionally unauthenticated (browser redirect).
  app.use('/api/oauth', oauthRouter);

  app.use('/api/me', meRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/account/ai', accountAiRouter);
  app.use('/api/account/api-keys', accountApiKeysRouter);
  app.use('/api/providers', catalogRouter);

  app.use('/api/projects/:projectId/integrations', integrationsRouter);
  app.use('/api/projects/:projectId/publishers', publishersRouter);
  app.use('/api/projects/:projectId/publications', publicationsRouter);
  app.use('/api/projects/:projectId/schedules', schedulesRouter);
  // Knowledge file uploads are raw bytes (never JSON); parsed only for the
  // upload path so the global 1mb JSON limit does not constrain them.
  app.use(
    '/api/projects/:projectId/knowledge/sources/upload',
    express.raw({ type: () => true, limit: '12mb' }),
  );
  app.use('/api/projects/:projectId/knowledge', knowledgeRouter);
  app.use('/api/projects/:projectId/ai', aiSettingsRouter);
  app.use('/api/projects/:projectId/content', contentRouter);
  // Writer agent runs hang off one exact content item; mounted after the
  // content router so /:contentId/writer never collides with content routes.
  app.use('/api/projects/:projectId/content/:contentId/writer', writerRouter);
  // Media uploads are raw image bodies (never JSON), parsed only for media
  // routes so the global JSON limit does not constrain file uploads.
  app.use(
    '/api/projects/:projectId/media',
    express.raw({
      type: (req) => {
        const ct = req.headers['content-type'];
        return typeof ct === 'string' && /^image\//i.test(ct);
      },
      limit: '12mb',
    }),
  );
  app.use('/api/projects/:projectId/media', mediaRouter);
  app.use('/api/projects/:projectId/jobs', jobsRouter);
  app.use('/api/projects/:projectId/api-keys', projectApiKeysRouter);
  app.use('/api/projects/:projectId/gsc', projectGscRouter);
  app.use('/api/v1', v1Router);
  app.use('/api/projects/:projectId', seoRouter);

  // MCP over streamable HTTP (project API key auth). Routed here, after
  // resolveContainer so the per-session builder can reach Supabase + jobStore.
  app.use('/api/mcp', createMcpHttpRouter());

  // -- terminal handlers -----------------------------------------------------
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

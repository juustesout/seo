/**
 * Express application assembly. Mounts the capability catalog, user + project
 * data, integrations, publishers/publications, knowledge, jobs and the SEO
 * data read API under /api. Auth is optional at the app level (the Google
 * OAuth callback has no bearer token); every route decides its own guard.
 */

import express from 'express';
import type { Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { loadConfig } from './config.js';
import { resolveContainer, optionalAuth } from './http/middleware.js';
import { errorHandler, notFoundHandler } from './apiErrors.js';

import { meRouter } from './http/routes/me.js';
import { catalogRouter } from './http/routes/catalog.js';
import { oauthRouter } from './http/routes/oauth.js';
import { integrationsRouter } from './http/routes/integrations.js';
import { publishersRouter } from './http/routes/publishers.js';
import { publicationsRouter } from './http/routes/publications.js';
import { knowledgeRouter } from './http/routes/knowledge.js';
import { jobsRouter } from './http/routes/jobs.js';
import { seoRouter } from './http/routes/seo.js';

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
  app.use('/api/providers', catalogRouter);

  app.use('/api/projects/:projectId/integrations', integrationsRouter);
  app.use('/api/projects/:projectId/publishers', publishersRouter);
  app.use('/api/projects/:projectId/publications', publicationsRouter);
  app.use('/api/projects/:projectId/knowledge', knowledgeRouter);
  app.use('/api/projects/:projectId/jobs', jobsRouter);
  app.use('/api/projects/:projectId', seoRouter);

  // -- terminal handlers -----------------------------------------------------
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Shared route helpers for project-scoped routers. */

import type { Request } from 'express';
import { z } from 'zod';
import { ApiError } from '../../apiErrors.js';

export const uuidParam = z.string().uuid();

export function parseProjectId(req: Request): string {
  const parsed = uuidParam.safeParse(req.params.projectId);
  if (!parsed.success) throw ApiError.badRequest('Invalid project id');
  return parsed.data;
}

export function parseId(req: Request, key: string): string {
  const parsed = uuidParam.safeParse(req.params[key]);
  if (!parsed.success) throw ApiError.badRequest(`Invalid ${key}`);
  return parsed.data;
}

/** External base URL (scheme + host) used for OAuth redirects. */
export function redirectBase(req: Request): string {
  const configured = req.container.config.publicAppUrl;
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

export const PROVIDER_DISPLAY: Record<string, string> = {
  gsc: 'Google Search Console',
  dataforseo: 'DataForSEO',
};

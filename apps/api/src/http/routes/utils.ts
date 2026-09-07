/**
 * Shared route helpers for project-scoped routers.
 *
 * Every project-scoped route mounts under /api/projects/:projectId/...; these
 * helpers centralize param validation (fail fast on a malformed/non-UUID id
 * instead of letting a malformed value reach a DB query), OAuth redirect base
 * resolution (publicAppUrl wins, then the incoming request host), and human
 * provider names for error/diagnostic text.
 */

import type { Request } from 'express';
import { z } from 'zod';
import { ApiError } from '../../apiErrors.js';

/** Reusable UUID param validator (projectId and generic resource ids). */
export const uuidParam = z.string().uuid();

/** Validate and return req.params.projectId; 400 on anything else. */
export function parseProjectId(req: Request): string {
  const parsed = uuidParam.safeParse(req.params.projectId);
  if (!parsed.success) throw ApiError.badRequest('Invalid project id');
  return parsed.data;
}

/** Validate and return an arbitrary UUID route param (e.g. :contentId). */
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

/** Provider id -> display name used in UI-facing messages. */
export const PROVIDER_DISPLAY: Record<string, string> = {
  gsc: 'Google Search Console',
  dataforseo: 'DataForSEO',
};

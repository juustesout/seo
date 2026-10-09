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

/**
 * Express 5 types route params as `string | string[]` (repeatable segments).
 * A named `:param` segment is always a single string at runtime; this narrows
 * the type and fails fast if the shape is ever unexpected.
 */
export function routeParam(raw: string | string[] | undefined): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  throw ApiError.badRequest('Missing route parameter');
}

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

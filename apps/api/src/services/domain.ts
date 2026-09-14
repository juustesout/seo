/**
 * Bare-hostname domain normalization shared by competitor research and source
 * snapshot scoping. Living in its own module lets both depend on it without a
 * circular import, and keeps one definition of "what a domain is" in the API.
 */

import { COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';

/** A bare-hostname domain (labels of a-z0-9/-, at least one dot, real TLD). */
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Normalize a user/domain value to a bare hostname: strip scheme, userinfo,
 * path/query/fragment, port, a leading www and casing. Returns '' when nothing
 * usable remains so callers can reject rather than enqueue a meaningless target.
 */
export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** Normalize and validate a domain, throwing a 400 the edge can surface. */
export function assertDomain(raw: string): string {
  const domain = normalizeDomain(raw);
  if (!domain) throw ApiError.badRequest('A domain is required');
  if (domain.length > COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS || !DOMAIN_PATTERN.test(domain)) {
    throw ApiError.badRequest('Enter a valid domain, e.g. example.com');
  }
  return domain;
}

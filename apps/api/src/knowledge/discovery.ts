/**
 * Controlled link discovery helpers (KB9).
 *
 * Discovery is not a crawler: it walks a bounded number of in-scope pages from
 * one seed and proposes links for a human to approve. This module holds the
 * pure, independently testable policy shared by the discovery provider and the
 * service:
 *
 *   - one canonical URL normalization (lowercase host, drop fragment, fold
 *     default ports, consistent trailing slash, preserve query strings) so
 *     de-duplication is stable;
 *   - a conservative host/domain scope test so discovery never wanders off the
 *     seed site;
 *   - markdown link extraction.
 *
 * Every URL still passes through the SSRF guard (`validateExternalUrl`) before
 * it is proposed or fetched; scope is an additional, not a replacement, gate.
 */

import type { KnowledgeDiscoveryScope } from '@seo/contracts';
import { validateExternalUrl } from './url.js';

/** Multi-label public suffixes we special-case for `same_domain` scope. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  'asn.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'ac.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'co.in',
  'net.in',
  'org.in',
  'gen.in',
  'firm.in',
  'ind.in',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'co.za',
  'org.za',
  'net.za',
  'com.sg',
  'net.sg',
  'org.sg',
  'edu.sg',
  'gov.sg',
  'com.hk',
  'net.hk',
  'org.hk',
  'edu.hk',
  'gov.hk',
  'co.kr',
  'or.kr',
  'ne.kr',
  'com.mx',
  'org.mx',
  'net.mx',
  'com.tr',
  'org.tr',
  'net.tr',
  'co.il',
  'org.il',
  'net.il',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Canonical discovery URL. Returns the normalized URL string and throws
 * `knowledge_invalid_url` (through `validateExternalUrl`) for anything the SSRF
 * guard rejects. Query strings are preserved verbatim - discovery must not
 * silently drop parameters that may identify a distinct page.
 */
export function normalizeDiscoveryUrl(raw: string): string {
  const url = validateExternalUrl(raw);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** Normalize a hostname for scope comparison (lowercase, strip trailing dot). */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * Registrable domain (eTLD+1) for a hostname, using a conservative built-in
 * suffix list. IP literals and unknown shapes fall back to the host itself, so
 * an IP host only ever matches itself under `same_domain`.
 */
export function registrableDomain(hostname: string): string {
  const host = normalizeHost(hostname);
  if (!host || IPV4.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * True when `candidateHost` is within the discovery scope of `seedHost`:
 * identical host for `same_host`, or the same registrable domain for
 * `same_domain`.
 */
export function isWithinScope(
  seedHost: string,
  candidateHost: string,
  scope: KnowledgeDiscoveryScope,
): boolean {
  const seed = normalizeHost(seedHost);
  const candidate = normalizeHost(candidateHost);
  if (!seed || !candidate) return false;
  if (seed === candidate) return true;
  if (scope === 'same_host') return false;
  return registrableDomain(seed) === registrableDomain(candidate);
}

export interface ExtractedLink {
  url: string;
  title?: string;
}

/**
 * Extract http(s) links from markdown. Image syntax (`![alt](src)`) is ignored;
 * anchor titles (`[x](url "title")`) are dropped; duplicates within one page
 * are collapsed. The result is deliberately just text - callers normalize and
 * validate each URL.
 */
export function extractMarkdownLinks(markdown: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  const link = /(!?)\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = link.exec(markdown)) !== null) {
    if (match[1] === '!') continue;
    const url = match[3]!;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = match[2]!.trim();
    links.push(title ? { url, title } : { url });
  }
  const autolink = /<((?:https?:\/\/)[^>\s]+)>/g;
  while ((match = autolink.exec(markdown)) !== null) {
    const url = match[1]!;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url });
  }
  return links;
}

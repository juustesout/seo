/**
 * Central external-URL validation (KB3) - the single gate before any URL is
 * handed to a fetcher.
 *
 * This is an SSRF guard: only public http(s) URLs are allowed. Loopback,
 * private, link-local, CGNAT, multicast/reserved ranges, local hostnames and
 * URLs carrying userinfo credentials are rejected. Because the URL parser
 * normalizes numeric/hex/octal IPv4 forms to dotted-quad before we see the
 * hostname, those obfuscated loopback forms are blocked too.
 *
 * Note on DNS rebinding: the actual fetch happens at a remote fetcher (Jina),
 * but the application must still not knowingly forward private/local targets.
 * Literal-IP and local-hostname checks happen here, synchronously and without
 * network I/O so the guard is deterministic and independently testable.
 * `validateExternalUrl` is the only sanctioned entry point; callers must not
 * fetch a URL that did not pass through it.
 */

import { KnowledgeIngestError } from './errors.js';
import { MAX_URL_LENGTH } from './limits.js';

/** True for IPv4 literal ranges that must never be fetched (SSRF-safe). */
function isBlockedIpv4(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts as [number, number, number, number];
}

/** True for IPv6 literals that are loopback/private/link-local/multicast. */
function isBlockedIpv6(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isBlockedIpv4(...v4) : false;
  }
  // The WHATWG URL parser rewrites IPv4-mapped literals to hex groups
  // (::ffff:127.0.0.1 -> ::ffff:7f00:1), so decode the trailing 32 bits too.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIpv4((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
  }
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
  if (/^ff/.test(host)) return true; // ff00::/8 multicast
  if (host.startsWith('2001:db8')) return true; // documentation range
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return true;
  if (host.startsWith('[') || host.includes(':')) return isBlockedIpv6(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (!host.includes('.')) return true; // single-label hostnames resolve locally
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(...v4);
  return false;
}

/**
 * Validate an external URL for fetching. Returns the parsed URL on success and
 * throws `knowledge_invalid_url` otherwise. Enforces scheme, length, absence of
 * userinfo credentials and the SSRF host rules above.
 */
export function validateExternalUrl(raw: string): URL {
  if (typeof raw !== 'string') throw new KnowledgeIngestError('knowledge_invalid_url');
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) throw new KnowledgeIngestError('knowledge_invalid_url');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KnowledgeIngestError('knowledge_invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KnowledgeIngestError('knowledge_invalid_url');
  }
  if (url.username || url.password) throw new KnowledgeIngestError('knowledge_invalid_url');
  if (!url.hostname || isBlockedHost(url.hostname)) {
    throw new KnowledgeIngestError('knowledge_invalid_url');
  }
  return url;
}

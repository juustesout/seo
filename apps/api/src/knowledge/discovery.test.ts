/**
 * KB9 pure discovery helpers: canonical normalization, scope and markdown link
 * extraction. These are the policy primitives the provider and service share.
 */
import { describe, expect, it } from 'vitest';
import {
  extractMarkdownLinks,
  isWithinScope,
  normalizeDiscoveryUrl,
  registrableDomain,
} from './discovery.js';
import { KnowledgeIngestError } from './errors.js';

describe('normalizeDiscoveryUrl', () => {
  it('lowercases the host, drops the fragment and folds default ports', () => {
    expect(normalizeDiscoveryUrl('https://Example.COM:443/Path/?q=1#section')).toBe('https://example.com/Path?q=1');
    expect(normalizeDiscoveryUrl('http://Example.com:80/a')).toBe('http://example.com/a');
  });

  it('strips a trailing slash on non-root paths but keeps the origin slash', () => {
    expect(normalizeDiscoveryUrl('https://example.com/docs/')).toBe('https://example.com/docs');
    expect(normalizeDiscoveryUrl('https://example.com')).toBe('https://example.com/');
  });

  it('preserves meaningful query strings verbatim (no reordering, no dropping)', () => {
    expect(normalizeDiscoveryUrl('https://example.com/p?b=2&a=1&utm_source=x')).toBe(
      'https://example.com/p?b=2&a=1&utm_source=x',
    );
  });

  it('rejects unsupported schemes and private/localhost targets via the SSRF guard', () => {
    for (const bad of ['ftp://example.com/x', 'http://localhost/x', 'http://127.0.0.1/x', 'javascript:alert(1)']) {
      expect(() => normalizeDiscoveryUrl(bad), bad).toThrow(KnowledgeIngestError);
    }
  });
});

describe('scope helpers', () => {
  it('computes registrable domains conservatively', () => {
    expect(registrableDomain('blog.example.com')).toBe('example.com');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
  });

  it('same_host only allows the identical host', () => {
    expect(isWithinScope('example.com', 'example.com', 'same_host')).toBe(true);
    expect(isWithinScope('example.com', 'blog.example.com', 'same_host')).toBe(false);
    expect(isWithinScope('www.example.com', 'www.example.com', 'same_host')).toBe(true);
  });

  it('same_domain allows subdomains of the same registrable domain', () => {
    expect(isWithinScope('www.example.com', 'blog.example.com', 'same_domain')).toBe(true);
    expect(isWithinScope('example.com', 'other.com', 'same_domain')).toBe(false);
    expect(isWithinScope('news.bbc.co.uk', 'sport.bbc.co.uk', 'same_domain')).toBe(true);
  });
});

describe('extractMarkdownLinks', () => {
  it('extracts anchor links, drops images and captures titles', () => {
    const links = extractMarkdownLinks(
      [
        '# Title',
        '[Read more](https://example.com/a "A")',
        '![hero](https://example.com/img.png)',
        '<https://example.com/auto>',
      ].join('\n'),
    );
    expect(links).toEqual([
      { url: 'https://example.com/a', title: 'Read more' },
      { url: 'https://example.com/auto' },
    ]);
  });

  it('de-duplicates identical URLs within one page', () => {
    const links = extractMarkdownLinks('[a](https://example.com/x) and [b](https://example.com/x)');
    expect(links).toHaveLength(1);
  });

  it('ignores non-http links and plain text', () => {
    expect(extractMarkdownLinks('[mail](mailto:x@y.com) /relative /also-relative')).toEqual([]);
  });
});

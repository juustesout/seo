import { describe, expect, it } from 'vitest';
import { safeImageSrc, sanitizeArticleHtml } from './sanitizeHtml';

describe('sanitizeArticleHtml', () => {
  it('returns an empty string for missing input', () => {
    expect(sanitizeArticleHtml(null)).toBe('');
    expect(sanitizeArticleHtml(undefined)).toBe('');
    expect(sanitizeArticleHtml('')).toBe('');
  });

  it('keeps ordinary article markup', () => {
    const html = '<h2>Title</h2><p>Hello <strong>world</strong></p><ul><li>one</li></ul>';
    const out = sanitizeArticleHtml(html);
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('<li>one</li>');
  });

  it('removes script elements and their content', () => {
    const out = sanitizeArticleHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>ok</p>');
  });

  it('removes inline event handlers', () => {
    const out = sanitizeArticleHtml('<p onclick="alert(1)">hi</p><img src="https://x.test/a.png" onerror="alert(2)">');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).toContain('hi');
  });

  it('neutralizes a javascript: link but keeps the text', () => {
    const out = sanitizeArticleHtml('<p><a href="javascript:alert(1)">Click</a></p>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('Click');
  });

  it('neutralizes an entity-encoded javascript: link', () => {
    const out = sanitizeArticleHtml('<a href="java&#115;cript:alert(1)">Click</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps safe links and hardens target=_blank', () => {
    const out = sanitizeArticleHtml('<a href="https://example.com" target="_blank">Site</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('drops an unsafe image src', () => {
    const out = sanitizeArticleHtml('<img src="javascript:alert(1)" alt="x">');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('alt="x"');
  });

  it('unwraps unknown tags but preserves their text', () => {
    const out = sanitizeArticleHtml('<p>a <marquee>scroll</marquee> b</p>');
    expect(out).not.toContain('marquee');
    expect(out).toContain('scroll');
  });

  it('strips style attributes and comments', () => {
    const out = sanitizeArticleHtml('<p style="color:red">x</p><!-- secret -->');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('secret');
    expect(out).toContain('x');
  });
});

describe('safeImageSrc', () => {
  it('allows relative, http(s) and inline image data URLs', () => {
    expect(safeImageSrc('/a.png')).toBe('/a.png');
    expect(safeImageSrc('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('rejects javascript:, svg data URLs and non-strings', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeImageSrc('data:image/svg+xml;base64,AAAA')).toBeUndefined();
    expect(safeImageSrc(undefined)).toBeUndefined();
  });
});

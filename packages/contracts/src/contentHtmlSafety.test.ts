import { describe, expect, it } from 'vitest';
import { renderContentHtml, safeHref, type ContentBlock } from './content.js';
import { renderDocHtml, type TipDoc } from './contentDoc.js';

describe('safeHref', () => {
  it('allows http(s), mailto, tel and relative URLs', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeHref('tel:+123')).toBe('tel:+123');
    expect(safeHref('/relative/path')).toBe('/relative/path');
    expect(safeHref('relative')).toBe('relative');
  });

  it('rejects script-capable schemes regardless of case or whitespace', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref('  javascript:alert(1)  ')).toBeUndefined();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined();
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
  });

  it('rejects non-strings and empty values', () => {
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(42)).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
    expect(safeHref('   ')).toBeUndefined();
  });
});

describe('renderContentHtml link safety', () => {
  it('renders an allowed link', () => {
    const blocks: ContentBlock[] = [{ type: 'link', attrs: { text: 'Site', href: 'https://example.com' } }];
    expect(renderContentHtml(blocks)).toContain('<a href="https://example.com">Site</a>');
  });

  it('drops a javascript: href but keeps the text', () => {
    const blocks: ContentBlock[] = [{ type: 'link', attrs: { text: 'Click', href: 'javascript:alert(1)' } }];
    const html = renderContentHtml(blocks);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('Click');
  });
});

describe('renderDocHtml link safety', () => {
  const docWith = (href: string): TipDoc => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Click', marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  });

  it('renders an allowed link mark', () => {
    expect(renderDocHtml(docWith('https://example.com'))).toContain('<a href="https://example.com">Click</a>');
  });

  it('drops a javascript: link mark but keeps the text', () => {
    const html = renderDocHtml(docWith('javascript:alert(1)'));
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('Click');
  });

  it('drops an unsafe composition button href', () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        {
          type: 'compositionButton',
          attrs: { href: 'javascript:alert(1)' },
          content: [{ type: 'text', text: 'Go' }],
        },
      ],
    };
    const html = renderDocHtml(doc);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Go');
  });
});

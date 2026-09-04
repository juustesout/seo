import { describe, expect, it } from 'vitest';
import {
  contentOutline,
  contentWordCount,
  renderContentHtml,
  slugifyTitle,
  type ContentBlock,
} from '@seo/contracts';

const sample: ContentBlock[] = [
  { type: 'heading', attrs: { level: 2, text: 'Intro' } },
  { type: 'paragraph', attrs: { text: 'Hello <world> & co.' } },
  { type: 'list', attrs: { ordered: false, items: ['a', 'b', ''] } },
  { type: 'quote', attrs: { text: 'q', cite: 'source' } },
  { type: 'code', attrs: { text: 'const x = 1' } },
  { type: 'media', attrs: { kind: 'placeholder', alt: 'hero' } },
  { type: 'link', attrs: { text: 'docs', href: 'https://example.com' } },
];

describe('content render util (contracts)', () => {
  it('renders blocks to semantic html and escapes authored text', () => {
    const html = renderContentHtml(sample);
    expect(html).toContain('<h2>Intro</h2>');
    expect(html).toContain('Hello &lt;world&gt; &amp; co.');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<blockquote>q<cite>source</cite></blockquote>');
    expect(html).toContain('<pre><code>const x = 1</code></pre>');
    expect(html).toContain('data-media-placeholder="placeholder"');
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it('drops empty paragraphs from html', () => {
    const html = renderContentHtml([{ type: 'paragraph', attrs: { text: '  ' } }]);
    expect(html).toBe('');
  });

  it('derives outline from headings', () => {
    const outline = contentOutline(sample);
    expect(outline).toEqual([{ level: 2, text: 'Intro' }]);
  });

  it('counts words across blocks', () => {
    expect(contentWordCount(sample)).toBe(13);
  });

  it('slugifies titles', () => {
    expect(slugifyTitle('  How to Rank Higher — Guide! ')).toBe('how-to-rank-higher-guide');
    expect(slugifyTitle('Café & Crème')).toBe('cafe-creme');
  });
});

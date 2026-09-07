import { describe, expect, it } from 'vitest';
import { buildSocialTextPost, htmlToText, markdownToText } from './textPayload.js';
import type { PublishInput } from '@seo/contracts';

function input(overrides: Partial<PublishInput>): PublishInput {
  return { title: 'Demo article', content: '<p>Hello <b>world</b></p>', ...overrides };
}

describe('htmlToText', () => {
  it('strips tags and normalizes blocks to lines', () => {
    expect(htmlToText('<h1>Title</h1><p>Body one</p><p>Body two</p>')).toContain('Title');
    expect(htmlToText('<h1>Title</h1><p>Body one</p><p>Body two</p>')).toContain('Body one');
    expect(htmlToText('<p>a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>')).toContain('a&b <c> "d" \'e\'');
    expect(htmlToText('<script>bad()</script><p>ok</p>')).not.toContain('bad()');
  });
});

describe('markdownToText', () => {
  it('cleans links, emphasis, headings and images', () => {
    const md = '# Title\n\nCheck [the docs](https://x.dev) and **bold** _italic_.\n\n![alt](img.png)\n\n- item one\n- item two';
    const out = markdownToText(md);
    expect(out).toContain('Title');
    expect(out).toContain('the docs');
    expect(out).not.toContain('https://x.dev');
    expect(out).not.toContain('**');
    expect(out).not.toContain('![alt]');
    expect(out).toContain('item one');
  });
});

describe('buildSocialTextPost (canonical content -> platform payload)', () => {
  it('receives canonical content and produces a text post from title + excerpt + body', () => {
    const post = buildSocialTextPost(
      input({ title: 'My article', excerpt: 'Short summary', content: '<p>Full <b>body</b> text here</p>' }),
    );
    expect(post.text).toContain('My article');
    expect(post.text).toContain('Short summary');
    expect(post.text).toContain('Full body text here');
    expect(post.text).not.toContain('<');
  });

  it('does not duplicate the excerpt when it equals the body', () => {
    const post = buildSocialTextPost(input({ title: 'T', excerpt: 'same text', content: 'same text' }));
    const occurrences = post.text.split('same text').length - 1;
    expect(occurrences).toBeLessThanOrEqual(2);
  });

  it('handles undeclared markdown content', () => {
    const post = buildSocialTextPost(
      input({ title: 'T', content: '**bold** and [link](https://example.com)', excerpt: undefined }),
    );
    expect(post.text).toContain('bold');
    expect(post.text).toContain('link');
    expect(post.text).not.toContain('**');
  });

  it('truncates to the platform character limit with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const post = buildSocialTextPost(input({ title: 'T', content: long, excerpt: undefined }), { maxChars: 100 });
    expect(post.text.length).toBeLessThanOrEqual(100);
    expect(post.text.endsWith('…')).toBe(true);
  });
});

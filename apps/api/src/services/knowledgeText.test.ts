import { describe, expect, it } from 'vitest';
import { extractSourceText, normalizeText } from './knowledgeText.js';

describe('normalizeText', () => {
  it('normalizes line endings to LF', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses runs of spaces/tabs and strips trailing whitespace', () => {
    expect(normalizeText('  a   b\t\tc  ')).toBe('a b c');
    expect(normalizeText('line 1   \nline 2\t')).toBe('line 1\nline 2');
  });

  it('collapses 3+ blank lines to a single blank line but keeps paragraphs', () => {
    expect(normalizeText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeText('a\n\nb')).toBe('a\n\nb');
  });

  it('is deterministic and idempotent', () => {
    const once = normalizeText('  Hello   world.\r\n\r\n\r\nSecond   line.  ');
    expect(once).toBe('Hello world.\n\nSecond line.');
    expect(normalizeText(once)).toBe(once);
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeText('   \n\t  ')).toBe('');
  });
});

describe('extractSourceText', () => {
  it('extracts and normalizes a text source body', () => {
    const result = extractSourceText({
      source_type: 'text',
      name: 'My note',
      url: 'https://notes.example/x',
      content_text: 'Some\n\n  content  here.',
    });
    expect(result).toEqual({
      ok: true,
      value: { text: 'Some\n\ncontent here.', title: 'My note', url: 'https://notes.example/x' },
    });
  });

  it('reports empty text sources honestly', () => {
    const result = extractSourceText({ source_type: 'text', name: 'Blank', content_text: '   \n ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('empty');
      expect(result.reason).toMatch(/no text/i);
    }
  });

  it('is honest that URL fetching is not available', () => {
    const result = extractSourceText({ source_type: 'url', name: 'Ref', url: 'https://ref.example', content_text: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('indexes a URL source only when the user pasted real content', () => {
    const result = extractSourceText({
      source_type: 'url',
      name: 'Ref',
      url: 'https://ref.example',
      content_text: 'Captured body',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('Captured body');
  });

  it('is honest that file ingestion is not available and never fabricates text', () => {
    const result = extractSourceText({ source_type: 'file', name: 'Doc', content_text: 'whatever' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('falls back to the URL then a generic title when the name is blank', () => {
    const withUrl = extractSourceText({ source_type: 'text', name: '  ', url: 'https://x.example', content_text: 'body' });
    if (withUrl.ok) expect(withUrl.value.title).toBe('https://x.example');
    const withoutAnything = extractSourceText({ source_type: 'text', name: '', content_text: 'body' });
    if (withoutAnything.ok) expect(withoutAnything.value.title).toBe('Knowledge source');
  });
});

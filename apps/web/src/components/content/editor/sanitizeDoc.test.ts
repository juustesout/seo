import { describe, expect, it } from 'vitest';
import { sanitizeEditorDoc } from './sanitizeDoc';

describe('sanitizeEditorDoc', () => {
  it('keeps known content, images and composition nodes', () => {
    const doc = sanitizeEditorDoc({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
        { type: 'image', attrs: { mediaId: 'm1', src: 'https://cdn.example/a.png', alt: '' } },
        {
          type: 'compositionHero',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hero' }] }],
        },
        {
          type: 'compositionCta',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Go' }] }],
        },
        {
          type: 'compositionSection',
          content: [
            {
              type: 'compositionFeatureGrid',
              content: [
                {
                  type: 'compositionFeatureCard',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card' }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(doc.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'image',
      'compositionHero',
      'compositionCta',
      'compositionSection',
    ]);
  });

  it('preserves bounded composition attrs through sanitizing', () => {
    const doc = sanitizeEditorDoc({
      type: 'doc',
      content: [
        {
          type: 'compositionHero',
          attrs: { variant: 'centered', layout: { align: 'center' } },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hero' }] }],
        },
        {
          type: 'compositionButton',
          attrs: { variant: 'primary', href: 'https://example.com' },
          content: [{ type: 'text', text: 'Go' }],
        },
      ],
    });
    expect(doc.content?.[0]?.attrs).toEqual({ variant: 'centered', layout: { align: 'center' } });
    expect(doc.content?.[1]?.attrs).toEqual({ variant: 'primary', href: 'https://example.com' });
  });

  it('flattens unknown nodes instead of dropping their children', () => {    const doc = sanitizeEditorDoc({
      type: 'doc',
      content: [
        {
          type: 'featureGrid',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card copy' }] }],
        },
      ],
    });
    expect(doc.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'Card copy' }] }]);
  });

  it('marks empty unknown nodes instead of crashing', () => {
    const doc = sanitizeEditorDoc({
      type: 'doc',
      content: [{ type: 'notARealNode' }],
    });
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '[unsupported:notARealNode]' }] },
    ]);
  });

  it('returns an empty paragraph for missing documents', () => {
    expect(sanitizeEditorDoc(null).content).toEqual([{ type: 'paragraph' }]);
  });
});

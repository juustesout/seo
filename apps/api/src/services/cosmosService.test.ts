/**
 * Cosmos context rendering: deterministic, bounded, empty-omitting. Cosmos is
 * configuration only - these tests pin the exact shape AI prompts depend on.
 */
import { describe, expect, it } from 'vitest';
import { COSMOS_CONTEXT_MAX_CHARS, emptyCosmosConfig, parseCosmosConfig } from '@seo/contracts';
import { renderCosmosContext } from './cosmosService.js';

describe('renderCosmosContext', () => {
  it('renders nothing for an empty config', () => {
    expect(renderCosmosContext(emptyCosmosConfig())).toBe('');
  });

  it('renders populated sections in a stable order and omits empty fields', () => {
    const config = parseCosmosConfig({
      identity: { name: 'Acme', audience: 'Founders' },
      voice: { tone: 'Direct' },
      editorial: { forbidden: 'No hype' },
    });
    const text = renderCosmosContext(config);
    expect(text).toContain('Brand identity:');
    expect(text).toContain('- Name: Acme');
    expect(text).toContain('- Audience: Founders');
    expect(text).toContain('Voice:');
    expect(text).toContain('- Tone: Direct');
    expect(text).toContain('Editorial guidance:');
    expect(text).toContain('- Forbidden patterns: No hype');
    // Empty sections/fields never appear.
    expect(text).not.toContain('SEO guidance');
    expect(text).not.toContain('Knowledge guidance');
    expect(text).not.toContain('Positioning');
    expect(text.indexOf('Brand identity:')).toBeLessThan(text.indexOf('Voice:'));
    expect(text.indexOf('Voice:')).toBeLessThan(text.indexOf('Editorial guidance:'));
  });

  it('is deterministic (same config, same text)', () => {
    const config = parseCosmosConfig({ identity: { name: 'Acme' }, seo: { rules: 'One H1' } });
    expect(renderCosmosContext(config)).toBe(renderCosmosContext(config));
  });

  it('hard-caps the rendered block', () => {
    const config = parseCosmosConfig({
      editorial: { writingRules: 'x'.repeat(2000) },
      seo: { rules: 'y'.repeat(2000) },
      knowledge: { notes: 'z'.repeat(2000) },
    });
    const text = renderCosmosContext(config);
    expect(text.length).toBeLessThanOrEqual(COSMOS_CONTEXT_MAX_CHARS);
    expect(text.length).toBe(COSMOS_CONTEXT_MAX_CHARS);
  });
});

describe('parseCosmosConfig', () => {
  it('drops unknown keys and non-strings', () => {
    const config = parseCosmosConfig({
      identity: { name: 'Acme', secret: 'leak', description: 42 },
      hacker: 'nope',
    });
    expect(config.identity.name).toBe('Acme');
    expect(config.identity.description).toBe('');
    expect(Object.keys(config)).toEqual(['identity', 'voice', 'editorial', 'seo', 'knowledge']);
    expect(JSON.stringify(config)).not.toContain('leak');
    expect(JSON.stringify(config)).not.toContain('nope');
  });

  it('caps oversized fields', () => {
    const config = parseCosmosConfig({ voice: { tone: 'x'.repeat(5000) } });
    expect(config.voice.tone.length).toBe(2000);
  });

  it('defaults useProjectKnowledge to true unless explicitly false', () => {
    expect(parseCosmosConfig({}).knowledge.useProjectKnowledge).toBe(true);
    expect(parseCosmosConfig({ knowledge: { useProjectKnowledge: false } }).knowledge.useProjectKnowledge).toBe(false);
  });
});

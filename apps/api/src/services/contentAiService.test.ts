import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiErrors.js';
import {
  buildContentAiPrompt,
  mapContentAiError,
  parseContentAiOutput,
  ContentAiService,
} from './contentAiService.js';
import type { ServiceContainer } from '../context.js';

const KEYWORD = 'seo tooling';
const CHECKS = ['Fail — Content length: short (Warning line)'];

describe('content AI prompt building', () => {
  it('sends selection and directive for rewrite actions', () => {
    const p = buildContentAiPrompt(
      { action: 'rewrite', selection: '  Old copy here.  ' },
      KEYWORD,
      [],
    );
    expect(p.user).toContain('Target keyword: seo tooling');
    expect(p.user).toContain('<<<SELECTION');
    expect(p.user).toContain('Old copy here.');
    expect(p.system).toContain('Never invent statistics');
  });

  it('only attaches failing SEO checks for the improve_seo action', () => {
    const withChecks = buildContentAiPrompt({ action: 'improve_seo', selection: 'Copy.' }, KEYWORD, CHECKS);
    expect(withChecks.user).toContain('Content length');
    const plain = buildContentAiPrompt({ action: 'rewrite', selection: 'Copy.' }, KEYWORD, CHECKS);
    expect(plain.user).not.toContain('Content length');
  });

  it('builds a generate_section prompt from preceding context without a selection', () => {
    const p = buildContentAiPrompt({ action: 'generate_section', context: '…last paragraph…' }, null, []);
    expect(p.user).toContain('Preceding document context');
    expect(p.user).not.toContain('<<<SELECTION');
    expect(p.system).toContain('"text"');
  });

  it('keeps tone action user-directed when a tone is given', () => {
    const p = buildContentAiPrompt({ action: 'tone', selection: 'Copy.', tone: 'friendly' }, KEYWORD, []);
    expect(p.user).toContain('requested tone: friendly');
  });
});

describe('content AI output parsing', () => {
  it('parses strict JSON output', () => {
    expect(parseContentAiOutput('{"text":"New copy.","reason":"clearer"}')).toEqual({
      text: 'New copy.',
      reason: 'clearer',
    });
  });

  it('tolerates a code fence wrapper', () => {
    const out = parseContentAiOutput('```json\n{"text":"Hi"}\n```');
    expect(out.text).toBe('Hi');
    expect(out.reason).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseContentAiOutput('not json')).toThrowError(ApiError);
    expect(() => parseContentAiOutput('[1,2,3]')).toThrowError(ApiError);
  });

  it('rejects empty text output', () => {
    expect(() => parseContentAiOutput('{"text":"   ","reason":"nope"}')).toThrowError(ApiError);
  });

  it('rejects oversized output', () => {
    const huge = `{"text":"${'x'.repeat(12001)}","reason":"r"}`;
    expect(() => parseContentAiOutput(huge)).toThrowError(/too large/);
  });
});

describe('content AI error mapping', () => {
  it('maps 401/403 to invalid credentials', () => {
    const err = mapContentAiError(new Error('OpenAI API 401 Unauthorized on /chat/completions: nope'));
    expect(err.code).toBe('ai_invalid_credentials');
  });

  it('maps 429 to rate limited', () => {
    const err = mapContentAiError(new Error('OpenAI API 429 Rate limit reached'));
    expect(err.code).toBe('ai_rate_limited');
  });

  it('maps 5xx to a provider error', () => {
    const err = mapContentAiError(new Error('OpenAI API 503 Service Unavailable'));
    expect(err.code).toBe('ai_provider_error');
  });

  it('maps timeouts and network failures without leaking details', () => {
    expect(mapContentAiError(new Error('AI_TIMEOUT')).code).toBe('ai_timeout');
    const net = mapContentAiError(new Error('fetch failed: connection refused'));
    expect(net.code).toBe('ai_provider_error');
    expect(net.message).not.toContain('connection refused');
  });

  it('passes ApiError through unchanged', () => {
    const original = new ApiError(404, 'not_found', 'x');
    expect(mapContentAiError(original)).toBe(original);
  });
});

describe('ContentAiService selection guard', () => {
  it('rejects selection actions without selected text before touching storage', async () => {
    const service = new ContentAiService({} as unknown as ServiceContainer);
    await expect(
      service.run('p1', 'c1', { action: 'rewrite', selection: '' }),
    ).rejects.toThrowError(/Select text to edit first/);
  });

  it('does not enforce the selection guard for generate_section', async () => {
    const service = new ContentAiService({} as unknown as ServiceContainer);
    const message = await service
      .run('p1', 'c1', { action: 'generate_section' })
      .then(() => 'ok')
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).not.toContain('Select text to edit first');
  });
});

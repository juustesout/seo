/**
 * Content AI action service (SEO Core).
 *
 * Phase D turns the existing AI provider layer into safe in-editor document
 * actions. Every action returns a *suggestion* the client shows for review
 * (Apply / Reject); nothing here ever modifies the document or the persisted
 * seo_score. The deterministic SEO engine stays authoritative: AI input may
 * reference its checks but can never change the score.
 *
 * The AI provider itself is resolved through AIService (account BYOK key ->
 * project BYOK key -> server env) and the shared provider registry - Content
 * Studio has no provider-specific code.
 */

import type { AIProvider } from '@seo/contracts';
import {
  asTipDoc,
  evaluateSeo,
  type ContentAiAction,
  type ContentAiKnowledgeDto,
  type ContentAiSuggestionDto,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { AIService } from './aiService.js';
import { ContentService } from './contentService.js';

export interface ContentAiActionInput {
  action: ContentAiAction;
  /** Copy the user selected to edit (selection actions only). */
  selection?: string | null;
  /** Optional free-form instruction (appended to the action directive). */
  instruction?: string | null;
  /** Tone name for the 'tone' action. */
  tone?: string | null;
  /** Short preceding context the client computed around the selection. */
  context?: string | null;
  /** Client-provided target keyword override (never trusted for storage). */
  keyword?: string | null;
  /** When true (default), project knowledge passages may be offered as context. */
  useKnowledge?: boolean;
}

/** Deterministic checks whose fixes live inside body copy (usable by 'improve_seo'). */
const TEXT_RELEVANT_CHECKS = new Set([
  'content_length',
  'keyword_in_content',
  'keyword_in_introduction',
  'keyword_repetition',
  'paragraph_length',
  'excessive_repetition',
]);

const MAX_TOKENS: Record<ContentAiAction, number> = {
  rewrite: 1200,
  improve: 1200,
  expand: 1600,
  shorten: 900,
  tone: 1200,
  improve_seo: 1400,
  generate_section: 1600,
};

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 12000;

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

function actionDirective(input: ContentAiActionInput): string {
  switch (input.action) {
    case 'rewrite':
      return 'Rewrite the selection for clarity and flow, keeping the same meaning and roughly the same length.';
    case 'improve':
      return 'Improve the writing quality of the selection: make it sharper, more concrete and better flowing while keeping the same meaning and roughly the same length.';
    case 'expand':
      return 'Expand the selection with additional genuinely useful, non-fabricated detail, roughly doubling its length.';
    case 'shorten':
      return 'Shorten the selection to its essential points (roughly half its length) while preserving the meaning.';
    case 'tone':
      return input.tone?.trim()
        ? `Rewrite the selection in the requested tone: ${input.tone.trim()}. Keep the meaning intact.`
        : 'Rewrite the selection in a clearer, more professional tone while keeping the meaning intact.';
    case 'improve_seo':
      return 'Rework the selection to improve on-page SEO: use the target keyword naturally where it fits and address the listed failing checks. Do not stuff keywords and keep the meaning intact.';
    case 'generate_section':
      return 'Write a new document section that continues naturally from the preceding context. Return plain paragraphs separated by blank lines; if you want a subheading, start a line with "## " followed by the heading text (level 2 or 3 only). Do not repeat the preceding content.';
  }
}

function outputRule(): string {
  return 'Reply with ONLY a JSON object of the exact shape {"text": string, "reason": string}. "text" is the new copy as plain text with paragraphs separated by a single blank line - no markdown, no HTML, no code fences, no surrounding quotes. "reason" is a short one-line explanation of what changed. Never invent statistics, quotes, links, sources or citations; preserve the author\u2019s meaning and factual claims.';
}

export interface ContentAiPrompt {
  system: string;
  user: string;
}

/**
 * Renders supplied project-knowledge passages as an explicit, delimited
 * reference block. Passages are clearly separated from the document copy so
 * the model treats them as reference only - AI output must never be conflated
 * with supplied knowledge.
 */
export function knowledgePromptBlock(entries: ContentAiKnowledgeDto[]): string {
  if (entries.length === 0) return '';
  const refs = entries
    .map(
      (e, i) =>
        `[Source ${i + 1}]\nTitle: ${e.name}${e.url ? `\nURL: ${e.url}` : ''}\nPassage: ${e.excerpt ?? ''}`,
    )
    .join('\n\n');
  return [
    'Project knowledge base passages (reference material - they may or may not be relevant to the task).',
    "Treat them strictly as reference, never as the document author's own words. Do not copy them verbatim and do not invent facts beyond what they contain. If a passage is unrelated, ignore it. If you relied on any passage, name its title in your \"reason\".",
    '<<<KNOWLEDGE',
    refs,
    'KNOWLEDGE>>>',
  ].join('\n');
}

/**
 * Query text used to retrieve relevant project knowledge for an action.
 * Prefers the selected copy, then the target keyword, then the document title.
 */
export function contentAiKnowledgeQuery(
  input: ContentAiActionInput,
  keyword: string | null,
  title: string | null,
): string {
  const candidates = [input.selection?.trim(), keyword?.trim(), title?.trim()].filter(
    (c): c is string => Boolean(c),
  );
  return (candidates[0] ?? '').slice(0, 400);
}

/**
 * Builds the minimal context prompt for an AI action. Only the selection, its
 * immediate surrounding context, and metadata needed for the action are sent.
 */
export function buildContentAiPrompt(
  input: ContentAiActionInput,
  keyword: string | null,
  seoChecks: string[],
  knowledge: ContentAiKnowledgeDto[] = [],
): ContentAiPrompt {
  const directive = actionDirective(input);
  const extra = input.instruction?.trim();
  const parts: string[] = [];

  if (input.action === 'generate_section') {
    if (input.context?.trim()) {
      parts.push(`Preceding document context:\n${input.context!.trim()}`);
    }
    parts.push(directive);
  } else {
    if (keyword) parts.push(`Target keyword: ${keyword}`);
    if (input.action === 'improve_seo' && seoChecks.length > 0) {
      parts.push(`Relevant SEO checks to address in this selection:\n${seoChecks.join('\n')}`);
    }
    parts.push(directive);
    if (extra) parts.push(`Additional instruction: ${extra}`);
    if (input.selection?.trim()) {
      parts.push(`Selection to edit:\n<<<SELECTION\n${input.selection!.trim()}\nSELECTION>>>`);
    }
    if (input.context?.trim()) {
      parts.push(`Context that immediately precedes the selection:\n<<<CONTEXT\n${input.context!.trim()}\nCONTEXT>>>`);
    }
  }

  const block = knowledgePromptBlock(knowledge);
  if (block) parts.push(block);

  return { system: outputRule(), user: parts.join('\n\n') };
}

export interface ParsedAiOutput {
  text: string;
  reason: string | null;
}

/**
 * Parses + validates the strict JSON reply. Throws a 422 agent_invalid_output
 * for malformed or oversized output so callers never surface raw model text.
 */
export function parseContentAiOutput(content: string): ParsedAiOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(content));
  } catch {
    throw new ApiError(422, 'agent_invalid_output', 'The AI provider returned invalid output. Please try again.');
  }
  if (!raw || typeof raw !== 'object') {
    throw new ApiError(422, 'agent_invalid_output', 'The AI provider returned invalid output. Please try again.');
  }
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI provider returned empty output. Please try again.');
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    throw new ApiError(422, 'agent_output_too_large', 'The AI suggestion is too large. Please try a smaller selection.');
  }
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim().slice(0, 500) : null;
  return { text, reason };
}

/** Friendly, secret-free error surface for the AI action endpoint. */
export function mapContentAiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'AI_TIMEOUT') {
    return new ApiError(504, 'ai_timeout', 'The AI provider timed out. Please try again.');
  }
  const statusMatch = message.match(/OpenAI API\s+(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status !== null) {
    if (status === 401 || status === 403) {
      return new ApiError(502, 'ai_invalid_credentials', 'The AI provider rejected the API key. Update it under Account → Integrations.');
    }
    if (status === 429) {
      return new ApiError(429, 'ai_rate_limited', 'The AI provider is rate limiting requests. Wait a moment and try again.');
    }
    if (status >= 500) {
      return new ApiError(502, 'ai_provider_error', 'The AI provider returned an error. Please try again shortly.');
    }
  }
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return new ApiError(502, 'ai_provider_error', 'Could not reach the AI provider. Please try again shortly.');
  }
  return new ApiError(502, 'ai_provider_error', 'The AI provider returned an unexpected error. Please try again.');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI_TIMEOUT')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

async function chatJsonOnce(provider: AIProvider, system: string, user: string, maxTokens: number): Promise<ParsedAiOutput> {
  const result = await provider.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: 0.4,
    maxTokens,
  });
  return parseContentAiOutput(result.content);
}

export class ContentAiService {
  private readonly content: ContentService;
  private readonly ai: AIService;

  constructor(private readonly container: ServiceContainer) {
    this.content = new ContentService(container.sb);
    this.ai = new AIService(container);
  }

  /** Deterministic, body-copy-relevant failing checks used for 'improve_seo'. */
  private static seoChecksFor(
    row: Record<string, unknown>,
  ): { keyword: string | null; lines: string[] } {
    try {
      const result = evaluateSeo({
        doc: asTipDoc(row.content_json),
        meta: {
          title: typeof row.title === 'string' ? row.title : '',
          targetKeyword: typeof row.target_keyword === 'string' ? row.target_keyword : null,
          metaTitle: typeof row.meta_title === 'string' ? row.meta_title : null,
          metaDescription: typeof row.meta_description === 'string' ? row.meta_description : null,
        },
      });
      const lines = result.checks
        .filter((c) => (c.status === 'fail' || c.status === 'warn') && TEXT_RELEVANT_CHECKS.has(c.code))
        .slice(0, 5)
        .map((c) => `${c.status === 'fail' ? 'Fail' : 'Warn'} — ${c.label}: ${c.detail}${c.suggestion ? ` (${c.suggestion})` : ''}`);
      return { keyword: result.keyword, lines };
    } catch {
      return { keyword: null, lines: [] };
    }
  }

  /**
   * Best-effort project knowledge retrieval for an action. Returns [] when no
   * provider exists, nothing is indexed, or the search fails - normal Phase D
   * AI behavior must keep working without knowledge.
   */
  private async retrieveKnowledge(projectId: string, query: string): Promise<ContentAiKnowledgeDto[]> {
    const provider = this.container.registry?.getKnowledge?.('qdrant');
    if (!provider) return [];
    try {
      const hits = await provider.search({ query, projectId, limit: 3 });
      const entries: ContentAiKnowledgeDto[] = [];
      for (const hit of hits) {
        const payload = hit.payload as { title?: string; url?: string; source_type?: string; text?: string; source_id?: string };
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) continue;
        const entry: ContentAiKnowledgeDto = {
          name: payload.title || payload.source_id || 'Knowledge source',
          excerpt: text.slice(0, 600),
        };
        if (payload.url) entry.url = payload.url;
        entries.push(entry);
        if (entries.length >= 3) break;
      }
      return entries;
    } catch {
      // Knowledge is optional context - never fail the AI action because of it.
      return [];
    }
  }

  /**
   * Runs one AI action for a stored content row and returns a suggestion.
   * The client applies or rejects it; this method never writes the document.
   */
  async run(
    projectId: string,
    contentId: string,
    input: ContentAiActionInput,
  ): Promise<ContentAiSuggestionDto> {
    if (input.action !== 'generate_section' && !input.selection?.trim()) {
      throw ApiError.badRequest('Select text to edit first.');
    }

    const row = await this.content.get(projectId, contentId);
    const resolved = await this.ai.resolve(projectId);
    if (!resolved.configured || !resolved.provider.isConfigured()) {
      throw ApiError.notConfigured(
        'AI is not configured for this account or project. Add an OpenAI key under Account → Integrations.',
      );
    }
    const provider = resolved.provider;

    const { keyword, lines } = ContentAiService.seoChecksFor(row);
    const effectiveKeyword = input.keyword?.trim() || keyword;

    let knowledge: ContentAiKnowledgeDto[] = [];
    if (input.useKnowledge !== false) {
      const query = contentAiKnowledgeQuery(input, effectiveKeyword, typeof row.title === 'string' ? row.title : null);
      if (query) knowledge = await this.retrieveKnowledge(projectId, query);
    }
    const { system, user } = buildContentAiPrompt(input, effectiveKeyword, lines, knowledge);

    let parsed: ParsedAiOutput;
    try {
      parsed = await withTimeout(
        chatJsonOnce(provider, system, user, MAX_TOKENS[input.action]),
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      throw mapContentAiError(err);
    }

    const suggestion: ContentAiSuggestionDto = {
      action: input.action,
      source: (input.action === 'generate_section' ? '' : input.selection?.trim() ?? '').slice(0, 8000),
      text: parsed.text,
      reason: parsed.reason,
      model: provider.id,
    };
    if (knowledge.length > 0) suggestion.knowledge = knowledge;
    return suggestion;
  }
}

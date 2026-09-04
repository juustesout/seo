/**
 * Content Agent application service (SEO Core).
 *
 * A staged LLM pipeline that turns a topic brief into structured content:
 *   1. brief/outline (meta + section plan)
 *   2. article (typed blocks, media placeholders where images were requested)
 *   3. persist as a draft through ContentService (shared by UI/REST/MCP)
 *
 * It runs inside a background job (content_generate), never inside an HTTP
 * handler. Knowledge base hits are only injected as context when the project
 * has a working Qdrant + embedding setup; otherwise the stage degrades to the
 * topic alone (never to invented facts).
 */

import type { ContentBlock } from '@seo/contracts';
import { contentWordCount } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { AIService } from './aiService.js';
import { ContentService } from './contentService.js';

export type ContentLengthValue = 'short' | 'medium' | 'long';

export interface GenerateContentInput {
  topic: string;
  targetKeyword?: string | null;
  language?: string;
  audience?: string | null;
  tone?: string | null;
  contentLength?: ContentLengthValue;
  /** Include best-effort project knowledge hits as research context. */
  includeKnowledge?: boolean;
  /** When set, the article includes media placeholders for later resolution. */
  imageHint?: string | null;
  imageCount?: number;
}

interface OutlineItem {
  heading: string;
  points: string[];
}

interface AgentBrief {
  title: string;
  meta_title?: string;
  meta_description?: string;
  excerpt?: string;
  outline: OutlineItem[];
}

const WORD_TARGETS: Record<ContentLengthValue, string> = {
  short: 'aim for roughly 300 words of body copy',
  medium: 'aim for roughly 600 words of body copy',
  long: 'aim for roughly 1000 words of body copy',
};

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

/**
 * Digs the block array out of an agent reply that may wrap it under common
 * keys (blocks/article/content) or return the array at the top level.
 */
function extractBlocks(value: unknown): ContentBlock[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is ContentBlock =>
        Boolean(item) && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string',
    );
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['blocks', 'article', 'content', 'document']) {
      if (key in record) {
        const found = extractBlocks(record[key]);
        if (found.length > 0) return found;
      }
    }
  }
  return [];
}

export class ContentAgentService {
  private readonly ai: AIService;
  private readonly content: ContentService;

  constructor(private readonly container: ServiceContainer) {
    this.ai = new AIService(container);
    this.content = new ContentService(container.sb);
  }

  private async chatJson(
    provider: Awaited<ReturnType<AIService['resolve']>>['provider'],
    stage: string,
    system: string,
    user: string,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const messages = [
        { role: 'system' as const, content: system },
        {
          role: 'user' as const,
          content:
            attempt === 0 ? user : `${user}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object, no code fences, no prose.`,
        },
      ];
      const result = await provider.chat({ messages, json: true, temperature: 0.4, maxTokens: 5000 });
      try {
        const parsed = JSON.parse(stripCodeFence(result.content)) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (err) {
        lastError = err;
      }
    }
    throw new ApiError(422, 'agent_invalid_output', `The ${stage} stage of the content agent returned invalid output`);
  }

  /** Best-effort project knowledge context; never fails the generation. */
  private async knowledgeContext(projectId: string, query: string): Promise<string[]> {
    const provider = this.container.registry.getKnowledge('qdrant');
    if (!provider) return [];
    try {
      const hits = await provider.search({ query, projectId, limit: 3 });
      return hits
        .filter((h) => typeof h.payload?.text === 'string' && h.payload.text.length > 0)
        .map((h) => {
          const payload = h.payload as { title?: string; url?: string; text?: string };
          const ref = payload.title || payload.url || 'knowledge base';
          return `${ref}: ${String(payload.text).slice(0, 500)}`;
        });
    } catch {
      return [];
    }
  }

  /**
   * Runs the staged pipeline and persists the result as a project draft.
   * Callers (worker executor) report progress between stages.
   */
  async generate(
    projectId: string,
    userId: string,
    input: GenerateContentInput,
    onStage?: (label: string, progress: number) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const resolved = await this.ai.resolve(projectId);
    if (!resolved.configured || !resolved.provider.isConfigured()) {
      throw ApiError.notConfigured('Project AI is not configured. Set an OpenAI key or a project BYOK key.');
    }
    const provider = resolved.provider;
    const language = input.language ?? 'en';

    await onStage?.('research', 5);
    const context = input.includeKnowledge ? await this.knowledgeContext(projectId, input.topic) : [];
    const knowledgeBlock =
      context.length > 0
        ? `\nResearch context from the project knowledge base (use only to enrich; do not contradict the topic):\n${context
            .map((c) => `- ${c}`)
            .join('\n')}`
        : '';

    await onStage?.('outline', 30);
    const brief = (await this.chatJson(
      provider,
      'outline',
      [
        'You are an SEO content strategist. Produce a content brief as JSON only.',
        'The JSON must match exactly this shape:',
        '{"title": string (<=60 chars, no trailing period), "meta_title": string (<=60 chars), "meta_description": string (<=160 chars), "excerpt": string (<=200 chars), "outline": [{"heading": string (heading text, <=70 chars), "points": string[1..4]}]}',
        'Use headings of 2..5 sections. Avoid clickbait. Write in the requested language.',
      ].join('\n'),
      [
        `Topic: ${input.topic}`,
        input.targetKeyword ? `Primary keyword: ${input.targetKeyword}` : '',
        input.audience ? `Audience: ${input.audience}` : '',
        input.tone ? `Tone: ${input.tone}` : '',
        `Language: ${language}`,
        knowledgeBlock,
      ]
        .filter(Boolean)
        .join('\n'),
    )) as unknown as AgentBrief;

    const outlineItems = Array.isArray(brief.outline) ? brief.outline.slice(0, 6) : [];
    if (!brief.title || outlineItems.length === 0) {
      throw new ApiError(422, 'agent_invalid_output', 'The outline stage produced an unusable content brief');
    }
    const keyword = input.targetKeyword?.trim() ?? '';

    await onStage?.('writing', 60);
    const imageHint = input.imageHint?.trim();
    const imageCount = Math.max(1, Math.min(input.imageCount ?? 2, 4));
    const imageInstruction = imageHint
      ? `\nThe article should include up to ${imageCount} visual breaks for the subject "${imageHint}". Represent each one as an inline media block: {"type":"media","attrs":{"kind":"placeholder","alt":"descriptive alt for the image","caption":"short caption"}} placed right after the paragraph it illustrates. Do not include images if the outline has fewer than 2 sections.`
      : '';

    const raw = (await this.chatJson(
      provider,
      'writing',
      [
        'You are an expert long-form writer producing structured article blocks as JSON only.',
        'Return exactly this shape (no extra wrapping keys, no prose outside the JSON):',
        '{"blocks":[{block objects...}]}',
        'Allowed block types:',
        '- {"type":"heading","attrs":{"level":2,"text":"..."}}',
        '- {"type":"paragraph","attrs":{"text":"..."}}',
        '- {"type":"list","attrs":{"ordered":false,"items":["...","..."]}}',
        '- {"type":"quote","attrs":{"text":"...","cite":"optional source"}}',
        '- {"type":"link","attrs":{"text":"...","href":"https://..."}} only for clearly relevant references',
        '- {"type":"media","attrs":{"kind":"placeholder","alt":"...","caption":"..."}} (only when the outline includes an image brief)',
        'Rules: write in a single language; every heading level 2..3 only (never level 1); use the primary keyword in the first paragraph and at least one subheading; use your outline, expanding each point into concrete, useful copy; do not invent statistics, quotes or sources; prefer short paragraphs; escape quotes inside text; every block must have a "type" and "attrs" object.',
      ].join('\n'),
      [
        `Title: ${brief.title}`,
        keyword ? `Primary keyword: ${keyword}` : '',
        `Meta description used: ${brief.meta_description ?? ''}`,
        `Language: ${language}`,
        'Section plan:',
        ...outlineItems.map((s) => `## ${s.heading}\n${s.points.map((p) => `- ${p}`).join('\n')}`),
        imageInstruction,
      ].join('\n'),
    )) as unknown;

    const rawBlocks = extractBlocks(raw);
    if (rawBlocks.length < 2) {
      throw new ApiError(422, 'agent_invalid_output', 'The writing stage produced an empty article');
    }

    await onStage?.('persist', 90);
    const row = await this.content.create(projectId, userId, {
      title: brief.title.slice(0, 300),
      targetKeyword: keyword || null,
      metaTitle: brief.meta_title ? brief.meta_title.slice(0, 300) : null,
      metaDescription: brief.meta_description ? brief.meta_description.slice(0, 1000) : null,
      excerpt: brief.excerpt ? brief.excerpt.slice(0, 2000) : null,
      language,
      status: 'draft',
      contentJson: rawBlocks as ContentBlock[],
    });

    const blocks = (row.content_json ?? []) as ContentBlock[];
    return {
      id: row.id as string,
      title: row.title as string,
      slug: row.slug as string,
      block_count: blocks.length,
      word_count: contentWordCount(blocks),
      media_placeholders: blocks.filter((b) => b.type === 'media').length,
      sections: outlineItems.length,
    };
  }
}

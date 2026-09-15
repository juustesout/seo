/**
 * Selection-scoped AI edit service (Cosmos AI editor foundation).
 *
 * One request path for every editor action (Rewrite / Improve / Shorten /
 * Expand / Ask AI). The backend - never the client - assembles the bounded
 * context: the selected copy, a nearby window derived from the *stored*
 * document, article metadata, the project's Cosmos guidance, deterministic SEO
 * checks and (optionally, bounded) project knowledge.
 *
 * The model must reply with a single structured operation,
 * `replace_selection`, whose `content` is a validated Tiptap block array. It can
 * never replace the whole document: the service validates the nodes against the
 * shared Tiptap schema and the client applies them only to the selected range.
 * Nothing here writes seo_content.
 */

import type { AIProvider } from '@seo/contracts';
import {
  CONTENT_AI_EDIT_OPERATIONS,
  asTipDoc,
  docPlainText,
  isValidDocStructure,
  type ContentAiEditOperation,
  type ContentAiEditRequestDto,
  type ContentAiEditResponseDto,
  type ContentAiKnowledgeDto,
  type TipNode,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { AIService } from './aiService.js';
import { ContentService } from './contentService.js';
import { getCosmosContext } from './cosmosService.js';
import {
  knowledgePromptBlock,
  mapContentAiError,
  retrieveProjectKnowledge,
  textSeoChecksForRow,
  withTimeout,
} from './contentAiService.js';

export const MAX_SELECTION_CHARS = 8000;
export const MAX_INSTRUCTION_CHARS = 500;
export const MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_BLOCKS = 200;
const CONTEXT_BEFORE_CHARS = 800;
const CONTEXT_AFTER_CHARS = 400;
const REQUEST_TIMEOUT_MS = 60_000;

/** Block node types the editor AI may emit. Deliberately excludes `image`
 *  (media is chosen by the author, not invented by the model). */
const AI_EDIT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
]);

/** Inline marks the editor AI may emit. Deliberately excludes `link` so the
 *  model can never invent a URL. */
const AI_EDIT_MARK_TYPES = new Set(['bold', 'italic', 'strike', 'code']);

const MAX_TOKENS: Record<ContentAiEditOperation, number> = {
  rewrite: 1200,
  improve: 1200,
  shorten: 900,
  expand: 1600,
  ask: 1400,
};

/** The single mapping from an operation id to its editing directive. */
function operationDirective(operation: ContentAiEditOperation, instruction: string | null): string {
  switch (operation) {
    case 'rewrite':
      return 'Rewrite the selected text so it reads clearly and flows well. Keep the same meaning, facts and roughly the same length.';
    case 'improve':
      return 'Improve the selected text: make it sharper, more concrete and better flowing while keeping the same meaning and roughly the same length.';
    case 'shorten':
      return 'Shorten the selected text to its essential points (roughly half the length) while preserving the meaning.';
    case 'expand':
      return 'Expand the selected text with additional genuinely useful, non-fabricated detail, roughly doubling its length.';
    case 'ask':
      return instruction
        ? `Apply this instruction to the selected text: ${instruction}`
        : 'Apply the requested change to the selected text.';
  }
}

/**
 * Strict output contract: one validated replace_selection operation. Kept in
 * one place so parseAiEditOutput can validate hard while the model stays
 * honest about facts and never emits HTML/markdown.
 */
function outputRule(): string {
  return [
    'You are editing an existing article. Reply with ONLY a JSON object of the exact shape:',
    '{"operation":"replace_selection","content":<BLOCKS>,"reason":<string>}',
    '"operation" must be exactly "replace_selection".',
    '"content" must be a JSON array (not wrapped in a doc node) of ProseMirror block nodes using ONLY these types: paragraph, heading (attrs.level 1-4), bulletList, orderedList, listItem, blockquote, codeBlock. Inline text nodes may use ONLY the marks bold, italic, strike, code.',
    'Do NOT output a doc wrapper, HTML, markdown, code fences, images or links. The blocks replace exactly the selected text - do not include the surrounding document or repeat content outside the selection.',
    'Never invent statistics, quotes, links, sources or citations; preserve the author\u2019s meaning and factual claims.',
    '"reason" is a short one-line explanation of what changed.',
  ].join('\n');
}

export interface AiEditArticleMeta {
  title: string;
  targetKeyword: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  language: string | null;
}

export interface BuildAiEditPromptArgs {
  input: ContentAiEditRequestDto;
  meta: AiEditArticleMeta;
  contextBefore: string;
  contextAfter: string;
  cosmosText: string;
  seoLines: string[];
  knowledge: ContentAiKnowledgeDto[];
}

/**
 * Builds the bounded prompt for one editor edit. Every block is optional and
 * only included when non-empty, so an unconfigured Cosmos or absent knowledge
 * adds nothing to the request.
 */
export function buildContentAiEditPrompt(args: BuildAiEditPromptArgs): { system: string; user: string } {
  const { input, meta, contextBefore, contextAfter, cosmosText, seoLines, knowledge } = args;
  const instruction = input.instruction?.trim() || null;
  const parts: string[] = [];

  const metaLines = [
    meta.title.trim() ? `Title: ${meta.title.trim()}` : '',
    meta.targetKeyword ? `Target keyword: ${meta.targetKeyword}` : '',
    meta.metaTitle ? `Meta title: ${meta.metaTitle}` : '',
    meta.metaDescription ? `Meta description: ${meta.metaDescription}` : '',
    meta.language ? `Language: ${meta.language}` : '',
  ].filter(Boolean);
  if (metaLines.length > 0) parts.push(`Article metadata:\n${metaLines.join('\n')}`);

  if (cosmosText.trim()) {
    parts.push(
      [
        'Project Cosmos (editorial/brand guidance - follow it, but never invent facts it does not contain).',
        '<<<COSMOS',
        cosmosText.trim(),
        'COSMOS>>>',
      ].join('\n'),
    );
  }

  if (seoLines.length > 0) {
    parts.push(`Deterministic SEO checks relevant to body copy:\n${seoLines.join('\n')}`);
  }

  parts.push(operationDirective(input.operation, instruction));

  if (contextBefore.trim()) {
    parts.push(`Text immediately before the selection (context only, do not edit):\n<<<BEFORE\n${contextBefore.trim()}\nBEFORE>>>`);
  }
  parts.push(`Selected text to edit:\n<<<SELECTION\n${input.text.trim()}\nSELECTION>>>`);
  if (contextAfter.trim()) {
    parts.push(`Text immediately after the selection (context only, do not edit):\n<<<AFTER\n${contextAfter.trim()}\nAFTER>>>`);
  }

  const block = knowledgePromptBlock(knowledge);
  if (block) parts.push(block);

  return { system: outputRule(), user: parts.join('\n\n') };
}

/**
 * Derives a bounded nearby window from the stored document around where the
 * selection text occurs. Never trusts client-supplied context. When the
 * selection cannot be located (e.g. the client has unsaved edits), falls back
 * to the head of the document so the model still gets some context.
 */
export function nearbyContext(
  fullText: string,
  selectionText: string,
): { before: string; after: string } {
  const selection = selectionText.trim();
  const index = selection ? fullText.indexOf(selection) : -1;
  if (index === -1) {
    return { before: fullText.slice(0, CONTEXT_BEFORE_CHARS), after: '' };
  }
  const before = fullText.slice(Math.max(0, index - CONTEXT_BEFORE_CHARS), index);
  const afterStart = index + selection.length;
  const after = fullText.slice(afterStart, afterStart + CONTEXT_AFTER_CHARS);
  return { before, after };
}

/** Walks one node, rejecting any type/mark outside the editor AI allowlist. */
function assertAllowedNode(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an invalid edit. Please try again.');
  }
  const record = node as TipNode;
  if (typeof record.type !== 'string') {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an invalid edit. Please try again.');
  }
  if (record.type === 'text') {
    if (typeof record.text !== 'string') {
      throw new ApiError(422, 'agent_invalid_output', 'The AI returned an invalid edit. Please try again.');
    }
    for (const mark of record.marks ?? []) {
      if (!mark || !AI_EDIT_MARK_TYPES.has(mark.type)) {
        throw new ApiError(422, 'agent_invalid_output', 'The AI returned an unsupported edit. Please try again.');
      }
    }
    return;
  }
  if (!AI_EDIT_BLOCK_TYPES.has(record.type)) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an unsupported edit. Please try again.');
  }
  for (const child of record.content ?? []) assertAllowedNode(child);
}

export interface ParsedAiEditOutput {
  content: TipNode[];
  reason: string | null;
}

/**
 * Parses + validates the model's structured reply. Rejects malformed JSON,
 * a wrong/missing operation, unsupported node types/marks, an oversized result,
 * and any structure the shared Tiptap validator would not accept.
 */
export function parseAiEditOutput(raw: string): ParsedAiEditOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned invalid output. Please try again.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned invalid output. Please try again.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.operation !== 'replace_selection') {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an unsupported operation. Please try again.');
  }
  // Accept the blocks directly, or a single doc wrapper (some models add one).
  let content = record.content;
  if (content && typeof content === 'object' && !Array.isArray(content) && (content as TipNode).type === 'doc') {
    content = (content as TipNode).content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an empty edit. Please try again.');
  }
  if (content.length > MAX_OUTPUT_BLOCKS) {
    throw new ApiError(422, 'agent_output_too_large', 'The AI edit is too large. Please try a smaller selection.');
  }
  if (JSON.stringify(content).length > MAX_OUTPUT_CHARS) {
    throw new ApiError(422, 'agent_output_too_large', 'The AI edit is too large. Please try a smaller selection.');
  }
  for (const node of content) assertAllowedNode(node);
  const nodes = content as TipNode[];
  if (!isValidDocStructure({ type: 'doc', content: nodes })) {
    throw new ApiError(422, 'agent_invalid_output', 'The AI returned an unsupported edit. Please try again.');
  }
  const reason =
    typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim().slice(0, 500) : null;
  return { content: nodes, reason };
}

/** Strip a markdown ```json fence some models add around JSON output. */
function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

export class ContentAiEditService {
  private readonly content: ContentService;
  private readonly ai: AIService;

  constructor(private readonly container: ServiceContainer) {
    this.content = new ContentService(container.sb);
    this.ai = new AIService(container);
  }

  /**
   * Runs one selection-scoped edit and returns a validated proposal. The client
   * previews and applies it; this method never writes the document.
   */
  async run(
    projectId: string,
    contentId: string,
    input: ContentAiEditRequestDto,
  ): Promise<ContentAiEditResponseDto> {
    if (!CONTENT_AI_EDIT_OPERATIONS.includes(input.operation)) {
      throw ApiError.badRequest('Unsupported AI edit operation.');
    }
    if (!input.text?.trim()) {
      throw ApiError.badRequest('Select text to edit first.');
    }
    if (input.operation === 'ask' && !input.instruction?.trim()) {
      throw ApiError.badRequest('Add an instruction for Ask AI.');
    }

    const row = await this.content.get(projectId, contentId);
    const resolved = await this.ai.resolve(projectId);
    if (!resolved.configured || !resolved.provider.isConfigured()) {
      throw ApiError.notConfigured(
        'AI is not configured for this account or project. Add an OpenAI key under Account → Integrations.',
      );
    }
    const provider = resolved.provider;

    const { keyword, lines } = textSeoChecksForRow(row);
    const cosmos = await getCosmosContext(this.container, projectId);

    const fullText = docPlainText(asTipDoc(row.content_json));
    const { before, after } = nearbyContext(fullText, input.text);

    let knowledge: ContentAiKnowledgeDto[] = [];
    if (cosmos.useProjectKnowledge) {
      const query = (input.text.trim() || keyword || '').slice(0, 400);
      if (query) knowledge = await retrieveProjectKnowledge(this.container, projectId, query);
    }

    const { system, user } = buildContentAiEditPrompt({
      input,
      meta: {
        title: typeof row.title === 'string' ? row.title : '',
        targetKeyword: keyword,
        metaTitle: typeof row.meta_title === 'string' ? row.meta_title : null,
        metaDescription: typeof row.meta_description === 'string' ? row.meta_description : null,
        language: typeof row.language === 'string' ? row.language : null,
      },
      contextBefore: before,
      contextAfter: after,
      cosmosText: cosmos.text,
      seoLines: lines,
      knowledge,
    });

    let parsed: ParsedAiEditOutput;
    try {
      parsed = await withTimeout(
        this.chatJsonOnce(provider, system, user, MAX_TOKENS[input.operation]),
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      throw mapContentAiError(err);
    }

    const response: ContentAiEditResponseDto = {
      operation: 'replace_selection',
      content: parsed.content,
      reason: parsed.reason,
      model: provider.id,
    };
    if (knowledge.length > 0) response.knowledge = knowledge;
    return response;
  }

  private async chatJsonOnce(
    provider: AIProvider,
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<ParsedAiEditOutput> {
    const result = await provider.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      json: true,
      temperature: 0.4,
      maxTokens,
    });
    return parseAiEditOutput(result.content);
  }
}

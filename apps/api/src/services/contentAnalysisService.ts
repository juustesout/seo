/**
 * Content analysis application service (SEO Core).
 *
 * Deterministic audit over structured content (score/issues/recommendations)
 * shared by the UI, REST v1 and MCP. The AI-assisted pass runs only inside the
 * content_analyze job and only appends extra recommendations - it never
 * replaces the reproducible deterministic report.
 */

import type { ContentBlock } from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { ContentService } from './contentService.js';
import { AIService } from './aiService.js';
import { analyzeContent, type ContentAnalysisReport } from './contentAnalysis.js';

function textOf(block: ContentBlock): string {
  if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote' || block.type === 'code') {
    return block.attrs.text;
  }
  if (block.type === 'list') return block.attrs.items.join(' ');
  if (block.type === 'link') return block.attrs.text;
  return '';
}

/** Compact prompt-safe view of the article (truncated) used for AI advice. */
function articlePreview(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'media' ? `[${b.attrs.kind}${b.attrs.alt ? ': ' + b.attrs.alt : ''}]` : textOf(b)))
    .join('\n')
    .slice(0, 12000);
}

export class ContentAnalysisService {
  private readonly content: ContentService;
  private readonly ai: AIService;

  constructor(private readonly container: ServiceContainer) {
    this.content = new ContentService(container.sb);
    this.ai = new AIService(container);
  }

  /** Deterministic audit (no network) of a project content row. */
  async analyze(projectId: string, contentId: string): Promise<{ id: string; report: ContentAnalysisReport }> {
    const row = await this.content.get(projectId, contentId);
    const blocks = (row.content_json ?? []) as ContentBlock[];
    const report = analyzeContent(blocks, {
      title: typeof row.title === 'string' ? row.title : undefined,
      targetKeyword: typeof row.target_keyword === 'string' ? row.target_keyword : undefined,
      metaTitle: typeof row.meta_title === 'string' ? row.meta_title : undefined,
      metaDescription: typeof row.meta_description === 'string' ? row.meta_description : undefined,
    });
    return { id: contentId, report };
  }

  /**
   * Runs the deterministic audit, optionally appends AI recommendations when a
   * working AI provider exists, and persists seo_score. Only the deterministic
   * report is authoritative - AI input is clearly labelled as suggestions.
   */
  async analyzeAndPersist(
    projectId: string,
    userId: string | null,
    contentId: string,
    opts: { withAi?: boolean } = {},
  ): Promise<{ id: string; report: ContentAnalysisReport; aiRecommendations: string[] }> {
    const row = await this.content.get(projectId, contentId);
    const blocks = (row.content_json ?? []) as ContentBlock[];
    const report = analyzeContent(blocks, {
      title: typeof row.title === 'string' ? row.title : undefined,
      targetKeyword: typeof row.target_keyword === 'string' ? row.target_keyword : undefined,
      metaTitle: typeof row.meta_title === 'string' ? row.meta_title : undefined,
      metaDescription: typeof row.meta_description === 'string' ? row.meta_description : undefined,
    });

    let aiRecommendations: string[] = [];
    if (opts.withAi) {
      const resolved = await this.ai.resolve(projectId);
      if (resolved.configured && resolved.provider.isConfigured()) {
        const provider = resolved.provider;
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const out = await provider.chat({
              json: true,
              temperature: 0.2,
              maxTokens: 2000,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are an SEO editor. Given an article and its deterministic audit, return JSON exactly shaped as {"recommendations": string[1..6]} of concrete, copy-able improvement suggestions. Do not restate the audit issues verbatim; go deeper (search intent coverage, entities, structure, internal linking opportunities).',
                },
                {
                  role: 'user',
                  content: `Deterministic score: ${report.score}\nIssues: ${report.issues
                    .map((i) => `${i.severity}:${i.code}`)
                    .join(', ')}\nArticle:\n${articlePreview(blocks)}`,
                },
              ],
            });
            const parsed = JSON.parse(out.content.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')) as {
              recommendations?: unknown;
            };
            if (Array.isArray(parsed.recommendations)) {
              aiRecommendations = parsed.recommendations
                .filter((r): r is string => typeof r === 'string' && r.length > 0)
                .slice(0, 6);
            }
            break;
          } catch (err) {
            lastError = err;
            if (attempt === 1 && lastError) {
              throw new ApiError(422, 'agent_invalid_output', 'The AI analysis pass returned invalid output');
            }
          }
        }
      }
    }

    await this.content.update(projectId, userId, contentId, { seoScore: report.score });
    return { id: contentId, report, aiRecommendations };
  }
}

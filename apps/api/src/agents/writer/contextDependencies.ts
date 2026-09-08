/**
 * Production wiring for the writer's read-only context allowlist (W1).
 *
 * These adapters are the only production link between the writer graph and
 * the existing project-scoped services. Each one enforces project scope
 * itself (every read is filtered by the projectId the graph hands it), is
 * strictly read-only, degrades honestly per source, and deliberately does NOT
 * reuse the one-shot AI pipeline or add any new research engine - the
 * intelligence adapter mirrors the exact-match keyword read Phase G already
 * uses (contentIntelligenceService.dataforseoSignals), returning only stored,
 * evidence-backed rows.
 *
 * The graph never talks to these services directly; it calls the adapter
 * allowlist injected by the caller.
 */

import type { ContentStatus } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import type { ServiceContainer } from '../../context.js';
import { logger } from '../../logger.js';
import { ContentService } from '../../services/contentService.js';
import { KnowledgeService } from '../../services/knowledgeService.js';
import type {
  WriterContentItem,
  WriterContentResult,
  WriterContextDependencies,
  WriterContextInput,
  WriterIntelligenceKeyword,
  WriterIntelligenceResult,
  WriterKnowledgeChunk,
  WriterKnowledgeResult,
} from './context.js';

/** How many hits to ask Qdrant for; the graph caps the stored result lower. */
const KNOWLEDGE_SEARCH_LIMIT = 10;
/** How many keyword rows to ask for on the exact keyword; graph caps lower. */
const KEYWORD_QUERY_LIMIT = 20;
/** How many project content rows the overlap scan may read. */
const CONTENT_SCAN_LIMIT = 100;

type Row = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Knowledge hit payload fields the provider writes at index time. */
interface KnowledgeHitPayload {
  source_id?: unknown;
  title?: unknown;
  url?: unknown;
  text?: unknown;
}

function mapKnowledgeHit(hit: { id: string; payload: Record<string, unknown> }): WriterKnowledgeChunk | null {
  const payload = hit.payload as KnowledgeHitPayload;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const sourceId = nullableString(payload.source_id) ?? hit.id;
  if (!text) return null;
  return { sourceId, title: title || undefined, text };
}

function mapContentRow(row: Row): WriterContentItem | null {
  const id = nullableString(row.id);
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!id || !title) return null;
  return {
    id,
    title,
    slug: nullableString(row.slug),
    targetKeyword: nullableString(row.target_keyword),
    status: String(row.status ?? '') as ContentStatus,
  };
}

function mapKeywordRow(row: Row): WriterIntelligenceKeyword {
  return {
    keyword: String(row.keyword ?? ''),
    volume: nullableNumber(row.volume),
    difficulty: nullableNumber(row.difficulty),
    cpc: nullableNumber(row.cpc),
    provider: nullableString(row.provider),
    lastSeenAt: nullableString(row.last_seen_at),
  };
}

/** True when a keyword row carries at least one measured demand signal. */
function hasEvidence(row: WriterIntelligenceKeyword): boolean {
  return row.volume !== null || row.difficulty !== null || row.cpc !== null;
}

/** Builds the production context adapters for a live service container. */
export function createWriterContextDependencies(container: ServiceContainer): WriterContextDependencies {
  const contentService = new ContentService(container.sb);
  const knowledgeService = new KnowledgeService(container);

  async function getKnowledge(input: WriterContextInput): Promise<WriterKnowledgeResult> {
    const reason = knowledgeService.configuredReason();
    if (reason) {
      return { status: 'not_configured', note: reason, chunks: [] };
    }
    const provider = container.registry.getKnowledge('qdrant');
    if (!provider) {
      return { status: 'not_configured', note: 'The knowledge provider is not registered on this server.', chunks: [] };
    }
    try {
      const hits = await provider.search({ query: input.topic, projectId: input.projectId, limit: KNOWLEDGE_SEARCH_LIMIT });
      const chunks = hits.map(mapKnowledgeHit).filter((c): c is WriterKnowledgeChunk => c !== null);
      return {
        status: chunks.length > 0 ? 'available' : 'empty',
        note: null,
        chunks,
      };
    } catch (err) {
      logger.warn({ err, projectId: input.projectId }, 'writer knowledge context unavailable');
      return { status: 'unavailable', note: 'Knowledge could not be searched right now.', chunks: [] };
    }
  }

  async function getExistingContent(input: WriterContextInput): Promise<WriterContentResult> {
    const search = input.targetKeyword ?? input.topic;
    try {
      const { content } = await contentService.list(input.projectId, { search, limit: CONTENT_SCAN_LIMIT });
      const items = content.map(mapContentRow).filter((c): c is WriterContentItem => c !== null);
      return {
        status: items.length > 0 ? 'available' : 'empty',
        note: null,
        items,
      };
    } catch (err) {
      logger.warn({ err, projectId: input.projectId }, 'writer existing-content context unavailable');
      return { status: 'unavailable', note: 'Existing content could not be read right now.', items: [] };
    }
  }

  /** DataForSEO may be connected at the project or the account level (mirrors
   *  contentIntelligenceService.dataforseoConnected). */
  async function dataforseoConnected(projectId: string): Promise<boolean> {
    try {
      const projectLevel = await container.sb
        .from('seo_integrations')
        .select('id')
        .eq('project_id', projectId)
        .eq('provider_type', 'dataforseo')
        .eq('status', 'connected')
        .limit(1);
      if (!projectLevel.error && (projectLevel.data ?? []).length > 0) return true;
      const accountRow = await container.sb
        .from('seo_projects')
        .select('account_id')
        .eq('id', projectId)
        .maybeSingle<{ account_id: string | null }>();
      const accountId = (accountRow.data?.account_id as string | null) ?? null;
      if (!accountId) return false;
      const accountLevel = await container.sb
        .from('seo_integrations')
        .select('id')
        .eq('account_id', accountId)
        .is('project_id', null)
        .eq('provider_type', 'dataforseo')
        .eq('status', 'connected')
        .limit(1);
      return !accountLevel.error && (accountLevel.data ?? []).length > 0;
    } catch (err) {
      logger.warn({ err, projectId }, 'writer dataforseo connectivity probe failed');
      return false;
    }
  }

  async function getIntelligence(input: WriterContextInput): Promise<WriterIntelligenceResult> {
    if (!(await dataforseoConnected(input.projectId))) {
      return {
        status: 'not_configured',
        note: 'Connect DataForSEO to surface keyword volume and difficulty for this target.',
        keywords: [],
      };
    }
    const kw = input.targetKeyword?.trim() ?? '';
    if (!kw) {
      return {
        status: 'no_data',
        note: 'Set a target keyword to match it against tracked keyword research.',
        keywords: [],
      };
    }
    try {
      const { data, error } = await container.sb
        .from('seo_keywords')
        .select('keyword,volume,difficulty,cpc,provider,last_seen_at')
        .eq('project_id', input.projectId)
        .ilike('keyword', kw)
        .limit(KEYWORD_QUERY_LIMIT);
      if (error) {
        logger.warn({ err: error, projectId: input.projectId }, 'writer keyword context unavailable');
        return { status: 'unavailable', note: 'Tracked keywords could not be read right now.', keywords: [] };
      }
      const exact = ((data ?? []) as Row[]).filter(
        (r) => String(r.keyword ?? '').toLowerCase() === kw.toLowerCase(),
      );
      const keywords = exact.map(mapKeywordRow).filter(hasEvidence);
      return {
        status: keywords.length > 0 ? 'configured' : 'no_data',
        note:
          keywords.length > 0
            ? `Keyword demand data for "${kw}" from tracked research.`
            : exact.length > 0
              ? `"${kw}" is tracked but has no measured demand yet.`
              : `"${kw}" is not tracked yet.`,
        keywords,
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.warn({ err, projectId: input.projectId }, 'writer keyword context unavailable');
      return { status: 'unavailable', note: 'Tracked keywords could not be read right now.', keywords: [] };
    }
  }

  return { getKnowledge, getExistingContent, getIntelligence };
}

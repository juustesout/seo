/**
 * Production wiring for the writer's W10.3 intelligence allowlist.
 *
 * W10.3 intelligence combines several of the project's EXISTING read-only
 * sources - there is no new provider, no crawling, no autonomous search, no
 * direct SQL/provider/credential access from the agent. Every source is a
 * project-scoped service the platform already runs:
 *
 *   - knowledge          -> the W1 Qdrant knowledge adapter (context allowlist)
 *   - existing_content   -> the W1 existing-content context adapter
 *   - dataforseo         -> the stored, DataForSEO-backed keyword rows the W1
 *                           context adapter already reads (exact target only)
 *   - gsc                -> Search Console signals from the Phase G content
 *                           intelligence report (read-only aggregation)
 *   - content_intelligence -> the Phase G deterministic on-page report
 *
 * Each source degrades honestly (available | empty | not_configured |
 * unavailable) exactly like the W1/W10.2 boundaries: a throwing adapter becomes
 * a truthful unavailable reading, an explicit not_configured ApiError keeps that
 * status, and no source ever fabricates a finding. All raw per-source readings
 * are bounded/sanitized/deduplicated later by boundIntelligence.
 */

import type { ContentIntelligenceReport, ContentRecommendation } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import type { ServiceContainer } from '../../context.js';
import { logger } from '../../logger.js';
import { ContentIntelligenceService } from '../../services/contentIntelligenceService.js';
import type { WriterContextDependencies } from './context.js';
import { contextNoteFromError } from './context.js';
import type {
  WriterContentResult,
  WriterIntelligenceResult,
  WriterKnowledgeResult,
} from './context.js';
import type {
  WriterIntelligenceDependencies,
  WriterIntelligenceRawFinding,
  WriterIntelligenceReading,
  WriterIntelligenceRequest,
  WriterIntelligenceSourceReading,
  WriterIntelligenceSourceStatus,
} from './intelligence.js';

/** A provider that explicitly signals "not configured" keeps that honest
 *  status instead of being flattened into a generic "unavailable". */
function isNotConfiguredError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'not_configured';
}

function readingStatus(err: unknown): WriterIntelligenceSourceStatus {
  return isNotConfiguredError(err) ? 'not_configured' : 'unavailable';
}

function failedReading(err: unknown, fallbackNote: string): WriterIntelligenceSourceReading {
  return { status: readingStatus(err), note: contextNoteFromError(err) || fallbackNote, findings: [] };
}

/** The W1 knowledge adapter speaks `available | empty | not_configured |
 *  unavailable` already, so its status maps straight across. */
function knowledgeReading(result: WriterKnowledgeResult): WriterIntelligenceSourceReading {
  const findings: WriterIntelligenceRawFinding[] = result.chunks.map((chunk) => ({
    type: 'knowledge',
    summary: chunk.title ? `${chunk.title}: ${chunk.text}` : chunk.text,
    evidenceIds: [chunk.sourceId],
  }));
  return { status: result.status, note: result.note, findings };
}

function contentReading(result: WriterContentResult): WriterIntelligenceSourceReading {
  const findings: WriterIntelligenceRawFinding[] = result.items.map((item) => ({
    type: 'content',
    summary: `${item.title} (status: ${item.status})${item.targetKeyword ? ` target: ${item.targetKeyword}` : ''}`,
    evidenceIds: [item.id],
  }));
  return { status: result.status, note: result.note, findings };
}

/** W1 keyword status uses `configured | no_data | not_configured | unavailable`;
 *  W10.3 uses `available | empty | not_configured | unavailable`. */
function keywordStatus(status: WriterIntelligenceResult['status']): WriterIntelligenceSourceStatus {
  switch (status) {
    case 'configured':
      return 'available';
    case 'no_data':
      return 'empty';
    default:
      return status;
  }
}

function keywordReading(result: WriterIntelligenceResult): WriterIntelligenceSourceReading {
  const findings: WriterIntelligenceRawFinding[] = result.keywords.map((row) => {
    const demand = [
      row.volume !== null ? `volume:${row.volume}` : '',
      row.difficulty !== null ? `difficulty:${row.difficulty}` : '',
      row.cpc !== null ? `cpc:${row.cpc}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      type: 'keyword',
      summary: `${row.keyword}${demand ? ` (${demand})` : ''}${row.provider ? ` [${row.provider}]` : ''}`,
      evidenceIds: [row.keyword],
    };
  });
  return { status: keywordStatus(result.status), note: result.note, findings };
}

/** Phase G source states map onto the W10.3 honesty vocabulary. */
function phaseGStatus(state: ContentIntelligenceReport['sources'][number]['state']): WriterIntelligenceSourceStatus {
  switch (state) {
    case 'configured':
      return 'available';
    case 'no_data':
      return 'empty';
    case 'not_configured':
      return 'not_configured';
  }
}

function phaseGSource(
  report: ContentIntelligenceReport,
  id: 'gsc' | 'dataforseo' | 'seo',
): ContentIntelligenceReport['sources'][number] | null {
  return report.sources.find((source) => source.id === id) ?? null;
}

function recommendationFinding(rec: ContentRecommendation): WriterIntelligenceRawFinding {
  const type =
    rec.source === 'dataforseo' ? 'keyword' : rec.source === 'knowledge' ? 'knowledge' : rec.source === 'seo' ? 'content' : 'opportunity';
  return {
    type,
    summary: rec.description ? `${rec.title}: ${rec.description}` : rec.title,
    evidenceIds: [rec.id, ...(rec.evidence ?? []).map((item) => item.label)],
  };
}

function reportReading(
  report: ContentIntelligenceReport,
  id: 'gsc' | 'seo',
  pick: (rec: ContentRecommendation) => boolean,
): WriterIntelligenceSourceReading {
  const source = phaseGSource(report, id);
  const findings = report.recommendations.filter(pick).map(recommendationFinding);
  if (!source) {
    return { status: findings.length > 0 ? 'available' : 'unavailable', note: null, findings };
  }
  return { status: phaseGStatus(source.state), note: source.note, findings };
}

/** Builds the production intelligence allowlist over the read-only context
 *  adapters and the Phase G content intelligence service. Every read is scoped
 *  by the projectId/contentId the graph hands the request; nothing is written,
 *  published, crawled or re-searched. */
export function createWriterIntelligenceDependencies(
  container: ServiceContainer,
  context: WriterContextDependencies,
): WriterIntelligenceDependencies {
  const contentIntelligence = new ContentIntelligenceService(container);

  return {
    async gather(input: WriterIntelligenceRequest): Promise<WriterIntelligenceReading> {
      const brief = {
        projectId: input.projectId,
        topic: input.topic,
        targetKeyword: input.targetKeyword ?? null,
      };

      const [knowledge, existingContent, dataforseo, report] = await Promise.all([
        context.getKnowledge(brief).catch((err): WriterKnowledgeResult => {
          const reading = failedReading(err, 'Knowledge could not be searched right now.');
          return { status: reading.status, note: reading.note, chunks: [] };
        }),
        context.getExistingContent(brief).catch((err): WriterContentResult => {
          const reading = failedReading(err, 'Existing content could not be read right now.');
          return { status: reading.status, note: reading.note, items: [] };
        }),
        context.getIntelligence(brief).catch((err): WriterIntelligenceResult => {
          const reading = failedReading(err, 'Tracked keywords could not be read right now.');
          return { status: keywordStatusFromReading(reading.status), note: reading.note, keywords: [] };
        }),
        contentIntelligence.report(input.projectId, input.contentId).catch((err) => {
          logger.warn({ err, projectId: input.projectId }, 'writer content intelligence report unavailable');
          return null;
        }),
      ]);

      const gsc = report
        ? reportReading(report, 'gsc', (rec) => rec.source === 'gsc')
        : failedReading(new Error('Content intelligence could not be read right now.'), 'Search Console signals could not be read right now.');
      const contentIntel = report
        ? reportReading(report, 'seo', (rec) => rec.source === 'seo' || rec.source === 'knowledge')
        : failedReading(new Error('Content intelligence could not be read right now.'), 'Content intelligence could not be read right now.');

      return {
        knowledge: knowledgeReading(knowledge),
        existingContent: contentReading(existingContent),
        dataforseo: keywordReading(dataforseo),
        gsc,
        contentIntelligence: contentIntel,
      };
    },
  };
}

/** Maps a fallback reading's W10.3 status back onto the W1 keyword status
 *  vocabulary when an adapter throws before returning a keyword result. */
function keywordStatusFromReading(status: WriterIntelligenceSourceStatus): WriterIntelligenceResult['status'] {
  switch (status) {
    case 'available':
      return 'configured';
    case 'empty':
      return 'no_data';
    default:
      return status;
  }
}

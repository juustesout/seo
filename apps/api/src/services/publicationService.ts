/**
 * Publication history application service (Content Studio Phase H3).
 *
 * Read-only surface over the existing seo_publications rows: project-scoped
 * listing with filters + bounded pagination, and a single-row detail. Every
 * read resolves to the safe PublicationDto - no credentials, no publisher
 * config, no article bodies (the canonical article stays in seo_content).
 * Publishing execution is untouched; this is visibility only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicationDto, PublicationStatus } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

type Row = Record<string, unknown>;

/** Publication statuses allowed by the seo_publications status check. */
export const PUBLICATION_STATUSES = [
  'queued',
  'publishing',
  'published',
  'failed',
  'updated',
  'deleted',
  'scheduled',
] as const satisfies readonly PublicationStatus[];

/** All history-safe columns; never content/excerpt/slug/created_by. */
const PUB_COLUMNS =
  'id, project_id, content_id, publisher_id, schedule_id, status, remote_id, target_url, error, scheduled_for, published_at, title, created_at, updated_at';

export interface PublicationListInput {
  content_id?: string;
  publisher_id?: string;
  schedule_id?: string;
  status?: PublicationStatus;
  limit: number;
  offset: number;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Reduce the stored error (jsonb text or {message}) to a safe short message. */
function safeError(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const obj = v as { message?: unknown; error?: unknown };
    const m = typeof obj.message === 'string' ? obj.message : typeof obj.error === 'string' ? obj.error : null;
    if (m) return m.slice(0, 1000);
    return JSON.stringify(v).slice(0, 1000);
  }
  const s = String(v).trim();
  return s.length > 0 ? s.slice(0, 1000) : null;
}

export class PublicationService {
  constructor(private readonly sb: SupabaseClient) {}

  async list(projectId: string, input: PublicationListInput): Promise<PublicationDto[]> {
    // The query is built conditionally because PostgREST filters are additive.
    let q = this.sb
      .from('seo_publications')
      .select(PUB_COLUMNS)
      .eq('project_id', projectId);
    if (input.content_id) q = q.eq('content_id', input.content_id);
    if (input.publisher_id) q = q.eq('publisher_id', input.publisher_id);
    if (input.schedule_id) q = q.eq('schedule_id', input.schedule_id);
    if (input.status) q = q.eq('status', input.status);

    // Newest activity first: real publications by their published_at, planned
    // rows (published_at null) sink below by created_at.
    const { data, error } = await q
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(input.offset, input.offset + input.limit - 1);

    if (error) {
      logger.error({ error }, 'publication list failed');
      throw ApiError.badRequest('Could not list publications');
    }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) return [];
    return this.enrich(projectId, rows);
  }

  async get(projectId: string, publicationId: string): Promise<PublicationDto> {
    const row = await this.require(projectId, publicationId);
    const [dto] = await this.enrich(projectId, [row]);
    return dto;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async require(projectId: string, publicationId: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_publications')
      .select(PUB_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', publicationId)
      .maybeSingle();
    if (error) {
      logger.error({ error }, 'publication detail failed');
      throw ApiError.badRequest('Could not load the publication');
    }
    if (!data) throw ApiError.notFound('Publication not found in this project');
    return data as Row;
  }

  /** Resolve content titles + publisher names with project-scoped batched reads. */
  private async enrich(projectId: string, rows: Row[]): Promise<PublicationDto[]> {
    const contentIds = new Set<string>();
    const publisherIds = new Set<string>();
    for (const r of rows) {
      if (typeof r.content_id === 'string') contentIds.add(r.content_id);
      if (typeof r.publisher_id === 'string') publisherIds.add(r.publisher_id);
    }
    const [contentRes, publisherRes] = await Promise.all([
      contentIds.size > 0
        ? this.sb.from('seo_content').select('id, title').eq('project_id', projectId).in('id', [...contentIds])
        : Promise.resolve({ data: [], error: null }),
      publisherIds.size > 0
        ? this.sb.from('seo_publishers').select('id, name').eq('project_id', projectId).in('id', [...publisherIds])
        : Promise.resolve({ data: [], error: null }),
    ]);
    const titles = new Map<string, string>();
    for (const c of (contentRes.data ?? []) as Row[]) titles.set(String(c.id), String(c.title ?? ''));
    const names = new Map<string, string>();
    for (const p of (publisherRes.data ?? []) as Row[]) names.set(String(p.id), String(p.name ?? ''));

    return rows.map((r) => {
      const contentId = typeof r.content_id === 'string' ? r.content_id : null;
      // Prefer the current content title; fall back to the title snapshot taken
      // when the publication row was created (covers direct posts and deleted
      // content without implying a live content link that no longer exists).
      const contentTitle = contentId && titles.has(contentId) ? titles.get(contentId)! : str(r.title);
      const publisherId = String(r.publisher_id);
      return {
        id: String(r.id),
        project_id: String(r.project_id),
        content_id: contentId,
        content_title: contentTitle,
        publisher_id: publisherId,
        publisher_name: names.get(publisherId) ?? null,
        schedule_id: typeof r.schedule_id === 'string' ? String(r.schedule_id) : null,
        status: (r.status as PublicationStatus) ?? 'queued',
        remote_id: str(r.remote_id),
        target_url: str(r.target_url),
        scheduled_for: iso(r.scheduled_for),
        published_at: iso(r.published_at),
        error: safeError(r.error),
        created_at: iso(r.created_at) ?? new Date(0).toISOString(),
        updated_at: iso(r.updated_at) ?? new Date(0).toISOString(),
      } satisfies PublicationDto;
    });
  }
}

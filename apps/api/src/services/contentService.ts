/**
 * Content application service (SEO Core).
 *
 * Structured content CRUD. seo_content.content_json is the canonical source of
 * truth (a Tiptap document {type:'doc',...} for Phase B content; older records
 * tolerate the legacy block array). content_html + outline are always derived
 * with the shared contracts renderer so the UI, REST, MCP and the content agent
 * agree on the same output.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  contentOutline,
  renderContentHtml,
  slugifyTitle,
  tiptapEmptyDoc,
  isTiptapDoc,
  isValidDocStructure,
  renderDocHtml,
  docHeadings,
  evaluateSeo,
  asTipDoc,
  type ContentBlock,
  type ContentOutlineItem,
  type TipDoc,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';

export const CONTENT_STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;

export type ContentStatusValue = (typeof CONTENT_STATUSES)[number];

const mediaAttrs = z
  .object({
    kind: z.enum(['image', 'video', 'audio', 'placeholder']),
    src: z.string().optional(),
    alt: z.string().optional(),
    caption: z.string().optional(),
  })
  .passthrough();

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), attrs: z.object({ level: z.number().int().min(1).max(6), text: z.string() }) }),
  z.object({ type: z.literal('paragraph'), attrs: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('list'), attrs: z.object({ ordered: z.boolean().optional(), items: z.array(z.string()) }) }),
  z.object({ type: z.literal('quote'), attrs: z.object({ text: z.string(), cite: z.string().optional() }) }),
  z.object({ type: z.literal('code'), attrs: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('media'), attrs: mediaAttrs }),
  z.object({ type: z.literal('link'), attrs: z.object({ text: z.string(), href: z.string() }) }),
]);

export const contentBlocksSchema = z.array(contentBlockSchema).max(500);

/** Write-path shape for content_json: a Tiptap document or (legacy) block array. */
export const contentJsonSchema = z.union([
  contentBlocksSchema,
  z
    .object({ type: z.literal('doc') })
    .passthrough()
    .refine((doc) => isValidDocStructure(doc), { message: 'content_json must be a valid Tiptap document' }),
]);

export interface ContentInput {
  title: string;
  slug?: string | null;
  url?: string | null;
  targetKeyword?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  excerpt?: string | null;
  language?: string;
  status?: ContentStatusValue;
  contentJson?: TipDoc | ContentBlock[];
  /** Retained for the analysis job; the value is ignored - seo_score is always
   *  recomputed from the canonical evaluator on write. */
  seoScore?: number | null;
}

export type ContentPatch = Partial<ContentInput>;

const LIST_COLUMNS =
  'id, project_id, title, slug, status, url, excerpt, target_keyword, meta_title, meta_description, seo_score, language, updated_at, created_at, published_at';

type Row = Record<string, unknown>;

export class ContentService {
  constructor(private readonly sb: SupabaseClient) {}

  async list(projectId: string, opts: { search?: string; status?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 200, 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = this.sb
      .from('seo_content')
      .select(LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (opts.status) q = q.eq('status', opts.status);
    if (opts.search) q = q.ilike('title', `%${opts.search}%`);
    const { data, error } = await q;
    if (error) {
      throw ApiError.badRequest('Could not list content');
    }
    const rows = (data ?? []) as Row[];
    return { content: rows, total: rows.length };
  }

  async get(projectId: string, id: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_content')
      .select(`${LIST_COLUMNS}, content_json, content_html, outline, created_by, updated_by`)
      .eq('project_id', projectId)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) throw ApiError.notFound('Content not found in this project');
    return data as Row;
  }

  private async uniqueSlug(projectId: string, title: string, prefer?: string | null, excludeId?: string): Promise<string> {
    const base = slugifyTitle(prefer?.trim() ? prefer : title) || 'untitled';
    let candidate = base;
    let n = 2;
    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = this.sb.from('seo_content').select('id').eq('project_id', projectId).eq('slug', candidate);
      if (excludeId) q = q.neq('id', excludeId);
      const { data, error } = await q.maybeSingle();
      if (error) throw ApiError.badRequest('Could not check slug availability');
      if (!data) return candidate;
      candidate = `${base}-${n++}`;
    }
  }

  private async write(
    projectId: string,
    userId: string | null,
    mode: 'create' | 'update',
    id: string | undefined,
    input: ContentPatch,
  ) {
    const existing = mode === 'update' ? await this.get(projectId, id!) : null;
    const status = (input.status ?? existing?.status ?? 'draft') as ContentStatusValue;

    const merged = {
      title: input.title ?? existing?.title,
      slug: input.slug !== undefined ? input.slug : (existing?.slug ?? null),
      url: input.url !== undefined ? input.url : (existing?.url ?? null),
      target_keyword: input.targetKeyword !== undefined ? input.targetKeyword : (existing?.target_keyword ?? null),
      meta_title: input.metaTitle !== undefined ? input.metaTitle : (existing?.meta_title ?? null),
      meta_description:
        input.metaDescription !== undefined ? input.metaDescription : (existing?.meta_description ?? null),
      excerpt: input.excerpt !== undefined ? input.excerpt : (existing?.excerpt ?? null),
      language: input.language ?? existing?.language ?? 'en',
    } as Row;

    const rawJson: TipDoc | ContentBlock[] =
      input.contentJson !== undefined ? input.contentJson : ((existing?.content_json ?? []) as TipDoc | ContentBlock[]);

    // Canonicalize whatever representation is stored so content_html and
    // outline are always derived from the same source in the same way.
    const isDoc = isTiptapDoc(rawJson);
    const content_json = mode === 'create' && input.contentJson === undefined ? tiptapEmptyDoc() : rawJson;
    const content_html = isDoc ? renderDocHtml(content_json as TipDoc) : renderContentHtml(content_json as ContentBlock[]);
    const outline = isDoc ? docHeadings(content_json as TipDoc) : contentOutline(content_json as ContentBlock[]);

    merged.slug = await this.uniqueSlug(projectId, merged.title as string, merged.slug as string | null, id);

    const payload = {
      ...merged,
      content_json,
      content_html,
      outline,
    } as Row;

    // seo_score always comes from the canonical deterministic evaluator - never
    // from a client-supplied value.
    payload.seo_score = evaluateSeo({
      doc: asTipDoc(content_json),
      meta: {
        title: typeof merged.title === 'string' ? merged.title : '',
        targetKeyword: typeof merged.target_keyword === 'string' ? merged.target_keyword : null,
        metaTitle: typeof merged.meta_title === 'string' ? merged.meta_title : null,
        metaDescription: typeof merged.meta_description === 'string' ? merged.meta_description : null,
      },
    }).score;

    const hasPublishedAt = existing?.published_at ? true : false;
    if (mode === 'create') {
      payload.project_id = projectId;
      payload.status = status;
      payload.published_at = status === 'published' ? new Date().toISOString() : null;
      if (userId) {
        payload.created_by = userId;
        payload.updated_by = userId;
      }
      const { data, error } = await this.sb.from('seo_content').insert(payload).select().single();
      if (error) throw ApiError.badRequest('Could not create content');
      return data as Row;
    }

    if (userId) payload.updated_by = userId;
    const { data, error } = await this.sb
      .from('seo_content')
      .update({
        ...payload,
        status,
        published_at: status === 'published' && !hasPublishedAt ? new Date().toISOString() : existing?.published_at ?? null,
      })
      .eq('project_id', projectId)
      .eq('id', id)
      .select()
      .single();
    if (error) throw ApiError.badRequest('Could not update content');
    return data as Row;
  }

  create(projectId: string, userId: string | null, input: ContentInput) {
    return this.write(projectId, userId, 'create', undefined, input);
  }

  update(projectId: string, userId: string | null, id: string, input: ContentPatch) {
    return this.write(projectId, userId, 'update', id, input);
  }

  async remove(projectId: string, id: string): Promise<void> {
    const { error } = await this.sb.from('seo_content').delete().eq('project_id', projectId).eq('id', id);
    if (error) throw ApiError.badRequest('Could not delete content');
  }
}

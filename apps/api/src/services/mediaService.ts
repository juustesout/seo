/**
 * Media library application service (SEO Core, Content Studio Phase F).
 *
 * Files live in project-scoped object storage; Postgres only ever holds
 * metadata (seo_media). Content documents reference library items by id, so the
 * library owns the asset: removing an item is refused while any content
 * document still references it. Content Studio logic never touches the storage
 * backend directly - it goes through the MediaObjectStore interface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sniffImage, type SniffedImage } from '../infra/imageBytes.js';
import type { MediaObjectStore } from '../infra/mediaStorage.js';
import { ApiError } from '../apiErrors.js';
import type { MediaItemDto } from '@seo/contracts';

/** Phase F upload cap (bytes). Request bodies are raw image bytes. */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_ALT_MAX = 500;
export const MEDIA_CAPTION_MAX = 2000;

const LIST_COLUMNS =
  'id, project_id, filename, mime_type, size, storage_key, width, height, alt_text, caption, created_by, created_at, updated_at';

type Row = Record<string, unknown>;

/** Strip traversal separators, control characters and absurdly long names. */
export function sanitizeFilename(name: string | null | undefined): string {
  const base = String(name ?? 'image').split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 180);
  return clean || 'image';
}

export interface UploadMediaInput {
  bytes: Buffer;
  /** Original client filename; sanitized and only used for display. */
  filename?: string | null;
  alt?: string | null;
}

export interface MediaPatchInput {
  altText?: string;
  caption?: string;
}

/** Map a row to the wire DTO; the URL is always derived from the object key. */
export function mapMediaRow(row: Row, store: MediaObjectStore, usageCount = 0): MediaItemDto {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    filename: String(row.filename ?? 'image'),
    mime_type: row.mime_type as MediaItemDto['mime_type'],
    size: Number(row.size ?? 0),
    url: store.urlFor(String(row.storage_key ?? '')),
    width: typeof row.width === 'number' ? row.width : null,
    height: typeof row.height === 'number' ? row.height : null,
    alt_text: String(row.alt_text ?? ''),
    caption: String(row.caption ?? ''),
    usage_count: usageCount,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class MediaService {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly store: MediaObjectStore,
  ) {}

  private async mediaRow(projectId: string, id: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('seo_media')
      .select(LIST_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) throw ApiError.notFound('Media item not found in this project');
    return data as Row;
  }

  /** Usage counts for the given media ids (distinct content documents). */
  private async usage(mediaIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (mediaIds.length === 0) return map;
    const { data, error } = await this.sb
      .from('seo_content_media')
      .select('content_id, media_id')
      .in('media_id', mediaIds);
    if (error) throw ApiError.badRequest('Could not read media usage');
    const seen = new Map<string, Set<string>>();
    for (const row of (data ?? []) as Row[]) {
      const mediaId = String(row.media_id);
      const contentId = String(row.content_id);
      const set = seen.get(mediaId) ?? new Set<string>();
      set.add(contentId);
      seen.set(mediaId, set);
    }
    for (const [id, contents] of seen) map.set(id, contents.size);
    return map;
  }

  async list(projectId: string): Promise<MediaItemDto[]> {
    const { data, error } = await this.sb
      .from('seo_media')
      .select(LIST_COLUMNS)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw ApiError.badRequest('Could not list media');
    const rows = (data ?? []) as Row[];
    const usage = await this.usage(rows.map((r) => String(r.id)));
    return rows.map((r) => mapMediaRow(r, this.store, usage.get(String(r.id)) ?? 0));
  }

  /**
   * Upload raw image bytes. The format is verified by sniffing the bytes (never
   * the client content-type/extension alone); SVG and anything else is refused.
   * Storage is written first, then the metadata row - if the row insert fails
   * the orphaned object is best-effort removed so we do not leak files.
   */
  async upload(projectId: string, userId: string | null, input: UploadMediaInput): Promise<MediaItemDto> {
    const { bytes } = input;
    if (!bytes || bytes.length === 0) throw ApiError.badRequest('No file body was received');
    if (bytes.length > MEDIA_MAX_BYTES) {
      throw ApiError.badRequest(`Image is too large (max ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB)`);
    }
    const sniffed: SniffedImage | null = sniffImage(bytes);
    if (!sniffed) {
      throw ApiError.badRequest('Unsupported file type - upload PNG, JPEG or WebP images only (SVG is not accepted)');
    }

    const stored = await this.store.upload({
      projectId,
      bytes,
      ext: sniffed.ext,
      contentType: sniffed.mime,
    });

    const payload = {
      project_id: projectId,
      filename: sanitizeFilename(input.filename),
      mime_type: sniffed.mime,
      size: bytes.length,
      storage_key: stored.key,
      width: sniffed.width,
      height: sniffed.height,
      alt_text: (input.alt ?? '').trim().slice(0, MEDIA_ALT_MAX),
      caption: '',
    } as Row;
    if (userId) payload.created_by = userId;

    const { data, error } = await this.sb.from('seo_media').insert(payload).select(LIST_COLUMNS).single();
    if (error) {
      // Do not leave an orphaned object behind when the metadata row fails.
      await this.store.remove(stored.key).catch(() => undefined);
      throw ApiError.badRequest('Could not record media metadata');
    }
    return mapMediaRow(data as Row, this.store);
  }

  /** Update library metadata (alt text / caption) for an item in this project. */
  async updateAttrs(projectId: string, mediaId: string, patch: MediaPatchInput): Promise<MediaItemDto> {
    await this.mediaRow(projectId, mediaId);
    const update: Row = {};
    if (patch.altText !== undefined) update.alt_text = patch.altText.trim().slice(0, MEDIA_ALT_MAX);
    if (patch.caption !== undefined) update.caption = patch.caption.trim().slice(0, MEDIA_CAPTION_MAX);
    const { data, error } = await this.sb
      .from('seo_media')
      .update(update)
      .eq('project_id', projectId)
      .eq('id', mediaId)
      .select(LIST_COLUMNS)
      .single();
    if (error || !data) throw ApiError.badRequest('Could not update media metadata');
    return mapMediaRow(data as Row, this.store);
  }

  /**
   * Remove a media item. The library owns the asset, so deletion is refused
   * while any content document references the item (seo_content_media also
   * enforces this with a RESTRICT foreign key as defense in depth).
   */
  async remove(projectId: string, mediaId: string): Promise<void> {
    const row = await this.mediaRow(projectId, mediaId);
    const { data, error } = await this.sb.from('seo_content_media').select('content_id').eq('media_id', mediaId);
    if (error) throw ApiError.badRequest('Could not check media usage');
    const references = (data ?? []) as Row[];
    if (references.length > 0) {
      throw ApiError.conflict(
        `This image is still used by ${references.length} content ${references.length === 1 ? 'document' : 'documents'}. Remove it from the document${references.length === 1 ? '' : 's'} first.`,
      );
    }
    await this.store.remove(String(row.storage_key));
    const { error: deleteError } = await this.sb.from('seo_media').delete().eq('project_id', projectId).eq('id', mediaId);
    if (deleteError) throw ApiError.badRequest('Could not delete media item');
  }
}

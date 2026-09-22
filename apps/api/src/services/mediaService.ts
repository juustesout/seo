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
import {
  isMediaSource,
  isValidMediaSourceMeta,
  type MediaItemDto,
  type MediaSource,
  type MediaSourceMeta,
} from '@seo/contracts';

/** Phase F upload cap (bytes) for raw image bodies, plus metadata length caps
 *  for alt text/caption so stored rows stay bounded. */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_ALT_MAX = 500;
export const MEDIA_CAPTION_MAX = 2000;

const LIST_COLUMNS =
  'id, project_id, filename, mime_type, size, storage_key, width, height, alt_text, caption, source, source_meta, created_by, created_at, updated_at';

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

/**
 * R4.5A: persist externally acquired image bytes (e.g. a downloaded stock photo)
 * as an ordinary project media row. The bytes are already sniffed by the caller,
 * and the provenance describes where they came from; `source` must never be
 * `upload` here because that value is reserved for user uploads.
 */
export interface ImportExternalMediaInput {
  bytes: Buffer;
  source: Exclude<MediaSource, 'upload'>;
  sourceMeta: MediaSourceMeta;
  filename?: string | null;
  alt?: string | null;
  caption?: string | null;
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
    source: isMediaSource(row.source) ? row.source : 'upload',
    source_meta: isValidMediaSourceMeta(row.source_meta) ? row.source_meta : {},
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

  /** Load one project-scoped media row; 404 when missing or foreign. */
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

  /** List this project's library, newest first, each row enriched with its
   *  distinct-content usage count (surfaced so the UI can warn before a delete
   *  is attempted). URLs are always derived from the storage key via the store. */
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
    return this.persist(projectId, userId, {
      bytes,
      sniffed,
      filename: input.filename,
      alt: input.alt,
      caption: '',
      source: 'upload',
      sourceMeta: {},
    });
  }

  /**
   * R4.5A: persist externally acquired bytes as an ordinary library row. The
   * caller has already downloaded the asset and sniffed the bytes; the same size
   * cap and format guarantees apply, and storage is written before metadata so a
   * failed insert can best-effort clean up the orphaned object.
   */
  async importExternal(
    projectId: string,
    userId: string | null,
    input: ImportExternalMediaInput,
  ): Promise<MediaItemDto> {
    const { bytes } = input;
    if (!bytes || bytes.length === 0) throw ApiError.badRequest('The downloaded image was empty');
    if (bytes.length > MEDIA_MAX_BYTES) {
      throw ApiError.badRequest(`Image is too large (max ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB)`);
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      throw ApiError.badRequest('The downloaded image is not a supported PNG, JPEG or WebP');
    }
    return this.persist(projectId, userId, {
      bytes,
      sniffed,
      filename: input.filename,
      alt: input.alt,
      caption: input.caption ?? '',
      source: input.source,
      sourceMeta: isValidMediaSourceMeta(input.sourceMeta) ? input.sourceMeta : {},
    });
  }

  /** Shared storage+row write used by uploads and external imports. */
  private async persist(
    projectId: string,
    userId: string | null,
    input: {
      bytes: Buffer;
      sniffed: SniffedImage;
      filename?: string | null;
      alt?: string | null;
      caption: string;
      source: MediaSource;
      sourceMeta: MediaSourceMeta;
    },
  ): Promise<MediaItemDto> {
    const stored = await this.store.upload({
      projectId,
      bytes: input.bytes,
      ext: input.sniffed.ext,
      contentType: input.sniffed.mime,
    });

    const payload = {
      project_id: projectId,
      filename: sanitizeFilename(input.filename),
      mime_type: input.sniffed.mime,
      size: input.bytes.length,
      storage_key: stored.key,
      width: input.sniffed.width,
      height: input.sniffed.height,
      alt_text: (input.alt ?? '').trim().slice(0, MEDIA_ALT_MAX),
      caption: input.caption.trim().slice(0, MEDIA_CAPTION_MAX),
      source: input.source,
      source_meta: input.sourceMeta,
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

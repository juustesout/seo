/**
 * Media object storage on Supabase Storage (public `seo-media` bucket).
 *
 * Why object storage instead of the database: image bytes are uploaded once to
 * the project's storage and content_json only ever carries the public object
 * URL. Embedding the base64 data URLs that image providers return straight into
 * content_json would bloat every content row, blow past JSON body limits and
 * make later content writes time out. The bucket is public because those URLs
 * end up in content that browsers render directly; keys are prefixed with the
 * project id (isolation) and carry a timestamp + random suffix (unguessable,
 * collision-free), so objects cannot be enumerated or overwritten across
 * projects. Uploads never overwrite (upsert: false): a key collision is an
 * error, not a silent replacement.
 */

import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Storage bucket shared by the image pipeline and the object store (public read). */
const BUCKET = 'seo-media';

/**
 * Make sure the bucket exists before the first upload. Supabase Storage does
 * not auto-create buckets, so this runs lazily on every upload path; a bucket
 * that cannot be created raises here instead of letting the subsequent upload
 * fail with a confusing missing-bucket error.
 */
async function ensureBucket(sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb.storage.getBucket(BUCKET);
  if (error && !data) {
    const created = await sb.storage.createBucket(BUCKET, { public: true });
    if (created.error) throw new Error(`Could not create storage bucket: ${created.error.message}`);
  }
}

/**
 * True when a string is a base64 data:image URL. Used to detect image-provider
 * results that must be offloaded to object storage before anything touches
 * content_json - they must never be persisted inline (see module header).
 */
export function isDataImage(value: string): boolean {
  return value.startsWith('data:image/');
}

/**
 * Uploads a data:image payload and returns its public URL. The regex is a
 * deliberate allow-list: only known raster formats with base64 body are
 * accepted, so arbitrary schemes, SVG text and non-base64 bodies are rejected
 * before they reach storage. The object key is derived server-side
 * (projectId + timestamp + random), never from client input, and uploaded with
 * upsert:false so an identical-name collision surfaces as an error rather than
 * a silent overwrite. Throws with an honest message when the payload is
 * unsupported or the upload fails, so the calling job surfaces a real error
 * instead of a fabricated URL.
 */
export async function storeImageDataUrl(sb: SupabaseClient, projectId: string, dataUrl: string): Promise<string> {
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error('Image provider returned an unsupported data URL');
  const ext = match[1] === 'jpg' ? 'jpg' : match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  const path = `${projectId}/${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
  await ensureBucket(sb);
  const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
    contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    upsert: false,
  });
  if (error) throw new Error(`Could not upload media to storage: ${error.message}`);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Object store (Content Studio Phase F). The media library depends on this
// narrow interface instead of Supabase directly, so the storage backend can
// change without touching Content Studio code. Reuses the same seo-media bucket
// and project-prefixed keys as the image pipeline above.
// ---------------------------------------------------------------------------

/** Result of an upload: the storage key plus its stable public URL. */
export interface StoredObject {
  key: string;
  url: string;
}

/**
 * Storage backend contract the media library codes against. Keeping Content
 * Studio behind this narrow interface instead of Supabase directly means the
 * backend can be swapped without touching callers. Uploads never overwrite
 * (a key collision is an error) and URLs are stable public URLs - never
 * expiring signed URLs - so they can be cached and embedded in content.
 */
export interface MediaObjectStore {
  /** Upload raw bytes under a project-prefixed, random, extension-safe key. */
  upload(args: { projectId: string; bytes: Buffer; ext: string; contentType: string }): Promise<StoredObject>;
  /** Remove an object. Throws when storage reports a failure (never silent). */
  remove(key: string): Promise<void>;
  /** Stable public URL for an existing key (never an expiring signed URL). */
  urlFor(key: string): string;
}

/**
 * MediaObjectStore over the shared Supabase `seo-media` bucket. Object keys are
 * `projectId/timestamp-random.ext`: the project prefix enforces isolation, the
 * timestamp + random component makes keys unique and unguessable, and the
 * extension is always a known-safe value derived from sniffed content rather
 * than caller input. The upload limit (12mb) is enforced at the HTTP layer in
 * app.ts; this store additionally refuses empty bodies.
 */
export class SupabaseStorageStore implements MediaObjectStore {
  constructor(private readonly sb: SupabaseClient) {}

  async upload(args: { projectId: string; bytes: Buffer; ext: string; contentType: string }): Promise<StoredObject> {
    if (args.bytes.length === 0) throw new Error('Refusing to store an empty object');
    const key = `${args.projectId}/${Date.now()}-${randomBytes(8).toString('hex')}.${args.ext}`;
    await ensureBucket(this.sb);
    const { error } = await this.sb.storage.from(BUCKET).upload(key, args.bytes, {
      contentType: args.contentType,
      upsert: false,
    });
    if (error) throw new Error(`Could not upload media to storage: ${error.message}`);
    return { key, url: this.urlFor(key) };
  }

  async remove(key: string): Promise<void> {
    const { error } = await this.sb.storage.from(BUCKET).remove([key]);
    if (error) throw new Error(`Could not remove media from storage: ${error.message}`);
  }

  /** Builds the public URL locally - no network round trip, so it never fails. */
  urlFor(key: string): string {
    return this.sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }
}

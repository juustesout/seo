/**
 * Media object storage on Supabase Storage.
 *
 * Content stays lean: image bytes are uploaded once to the project's storage
 * bucket and content_json only carries the public object URL. Without this,
 * base64 images returned by image providers would bloat every content row and
 * make later writes time out.
 */

import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'seo-media';

async function ensureBucket(sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb.storage.getBucket(BUCKET);
  if (error && !data) {
    const created = await sb.storage.createBucket(BUCKET, { public: true });
    if (created.error) throw new Error(`Could not create storage bucket: ${created.error.message}`);
  }
}

export function isDataImage(value: string): boolean {
  return value.startsWith('data:image/');
}

/**
 * Uploads a data:image payload and returns its public URL. Throws when the
 * payload is not a base64 image or the upload fails (honest error surfaced to
 * the job).
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

export interface StoredObject {
  key: string;
  url: string;
}

export interface MediaObjectStore {
  /** Upload raw bytes under a project-prefixed, random, extension-safe key. */
  upload(args: { projectId: string; bytes: Buffer; ext: string; contentType: string }): Promise<StoredObject>;
  /** Remove an object. Throws when storage reports a failure (never silent). */
  remove(key: string): Promise<void>;
  /** Stable public URL for an existing key (never an expiring signed URL). */
  urlFor(key: string): string;
}

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

  urlFor(key: string): string {
    return this.sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }
}

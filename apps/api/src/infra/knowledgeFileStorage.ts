/**
 * Private object storage for uploaded knowledge files (KB4).
 *
 * Bytes never enter Postgres or JSONB; the source row only keeps a
 * project/source-scoped object path in the private `seo-knowledge` bucket.
 * Unlike the public media bucket there is no public URL: downloads go through
 * the server, and the path is generated server-side from the project and source
 * ids plus a random suffix, never from the user's filename. Uploads never
 * overwrite (upsert:false) so a collision is an error, not silent data loss.
 *
 * The interface is the seam the service depends on, so tests inject a fake and
 * no test touches Supabase Storage.
 */

import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Private bucket for uploaded knowledge files (no public read). */
const BUCKET = 'seo-knowledge';

export interface KnowledgeFileStore {
  /** Persist bytes and return their private object path. */
  upload(args: {
    projectId: string;
    sourceId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ path: string }>;
  /** Read the bytes for an object path (ingestion re-extracts from storage). */
  download(path: string): Promise<Uint8Array>;
  /** Remove an object. Throws when storage reports a failure (never silent). */
  remove(path: string): Promise<void>;
}

/** Bucket exists lazily; Supabase Storage does not auto-create buckets. */
async function ensureBucket(sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb.storage.getBucket(BUCKET);
  if (error && !data) {
    const created = await sb.storage.createBucket(BUCKET, { public: false });
    if (created.error) throw new Error(`Could not create storage bucket: ${created.error.message}`);
  }
}

export class SupabaseKnowledgeFileStore implements KnowledgeFileStore {
  constructor(private readonly sb: SupabaseClient) {}

  async upload(args: {
    projectId: string;
    sourceId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ path: string }> {
    if (args.bytes.length === 0) throw new Error('Refusing to store an empty file');
    const path = `${args.projectId}/${args.sourceId}/${randomBytes(16).toString('hex')}`;
    await ensureBucket(this.sb);
    const { error } = await this.sb.storage.from(BUCKET).upload(path, Buffer.from(args.bytes), {
      contentType: args.contentType || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Could not upload knowledge file to storage: ${error.message}`);
    return { path };
  }

  async download(path: string): Promise<Uint8Array> {
    const { data, error } = await this.sb.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error(`Could not read knowledge file from storage: ${error?.message ?? 'not found'}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.sb.storage.from(BUCKET).remove([path]);
    if (error) throw new Error(`Could not remove knowledge file from storage: ${error.message}`);
  }
}

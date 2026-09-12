import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseKnowledgeFileStore } from './knowledgeFileStorage.js';

function fakeSupabase(opts: { bucketExists?: boolean; failUpload?: boolean; failRemove?: boolean; failDownload?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const uploads: Array<{ path: string; options: unknown }> = [];
  const bucketExists = opts.bucketExists ?? true;
  const getBucket = vi.fn(async () => (bucketExists ? { data: { id: 'seo-knowledge' }, error: null } : { data: null, error: { message: 'not found' } }));
  const createBucket = vi.fn(async () => ({ data: {}, error: null }));
  const from = vi.fn((_bucket: string) => ({
    upload: vi.fn(async (path: string, bytes: Uint8Array, options: unknown) => {
      if (opts.failUpload) return { data: null, error: { message: 'upload boom' } };
      objects.set(path, new Uint8Array(bytes));
      uploads.push({ path, options });
      return { data: { path }, error: null };
    }),
    download: vi.fn(async (path: string) => {
      if (opts.failDownload) return { data: null, error: { message: 'download boom' } };
      const bytes = objects.get(path);
      if (!bytes) return { data: null, error: { message: 'not found' } };
      return { data: { arrayBuffer: async () => bytes.slice().buffer }, error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      if (opts.failRemove) return { data: null, error: { message: 'remove boom' } };
      for (const p of paths) objects.delete(p);
      return { data: [], error: null };
    }),
  }));
  const sb = { storage: { getBucket, createBucket, from } } as unknown as SupabaseClient;
  return { sb, objects, uploads, getBucket, createBucket };
}

describe('SupabaseKnowledgeFileStore', () => {
  it('uploads under a project/source scoped path and round-trips bytes', async () => {
    const { sb, objects, uploads, createBucket } = fakeSupabase({ bucketExists: false });
    const store = new SupabaseKnowledgeFileStore(sb);
    const bytes = new TextEncoder().encode('file body');
    const { path } = await store.upload({ projectId: 'proj', sourceId: 'src', filename: 'a.txt', contentType: 'text/plain', bytes });

    expect(path.startsWith('proj/src/')).toBe(true);
    expect(objects.get(path)).toEqual(bytes);
    expect(uploads[0]!.options).toMatchObject({ contentType: 'text/plain', upsert: false });
    expect(createBucket).toHaveBeenCalledWith('seo-knowledge', { public: false });

    const downloaded = await store.download(path);
    expect(downloaded).toEqual(bytes);
  });

  it('refuses to store an empty file', async () => {
    const { sb } = fakeSupabase();
    const store = new SupabaseKnowledgeFileStore(sb);
    await expect(
      store.upload({ projectId: 'p', sourceId: 's', filename: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array() }),
    ).rejects.toThrow(/empty/i);
  });

  it('throws when storage reports an upload failure', async () => {
    const { sb } = fakeSupabase({ failUpload: true });
    const store = new SupabaseKnowledgeFileStore(sb);
    await expect(
      store.upload({ projectId: 'p', sourceId: 's', filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('x') }),
    ).rejects.toThrow(/upload/i);
  });

  it('throws when a download is missing or fails', async () => {
    const missing = new SupabaseKnowledgeFileStore(fakeSupabase().sb);
    await expect(missing.download('p/s/missing')).rejects.toThrow(/storage/i);
    const failing = new SupabaseKnowledgeFileStore(fakeSupabase({ failDownload: true }).sb);
    await expect(failing.download('p/s/x')).rejects.toThrow(/storage/i);
  });

  it('throws when storage reports a remove failure', async () => {
    const store = new SupabaseKnowledgeFileStore(fakeSupabase({ failRemove: true }).sb);
    await expect(store.remove('p/s/x')).rejects.toThrow(/remove/i);
  });
});

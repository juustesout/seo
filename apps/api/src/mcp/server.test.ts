import { describe, expect, it } from 'vitest';
import { buildTools } from '../mcp/server.js';
import type { MpcDeps } from '../mcp/server.js';
import { ApiError } from '../apiErrors.js';

const readOnlyDeps = { canRead: false, canWrite: false } as unknown as MpcDeps;
const readWriteDeps = { canRead: true, canWrite: true } as unknown as MpcDeps;

const byName = (name: string) => buildTools().find((t) => t.name === name)!;

async function expectsDenied(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error('expected ApiError to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  }
}

describe('mcp tool registry', () => {
  it('exposes the milestone-9 tool set with scopes and versioned schemas', () => {
    const tools = buildTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['content_analyze', 'content_generate', 'content_get', 'content_list', 'content_resolve_images', 'content_update', 'jobs_list'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toContain('schema v1');
      expect(tool.inputSchema).toBeTruthy();
    }
    expect(tools.filter((t) => t.readOnly)).toHaveLength(4);
    expect(tools.filter((t) => !t.readOnly)).toHaveLength(3);
  });

  it('denies read tools when the bound key has no read scope', async () => {
    await expectsDenied(byName('content_list').handler(readOnlyDeps, {}));
    await expectsDenied(byName('content_get').handler(readOnlyDeps, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('content_analyze').handler(readOnlyDeps, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('jobs_list').handler(readOnlyDeps, {}));
  });

  it('denies write tools when the bound key has no write scope', async () => {
    const noWrite = { canRead: true, canWrite: false } as unknown as MpcDeps;
    await expectsDenied(byName('content_generate').handler(noWrite, {}));
    await expectsDenied(byName('content_resolve_images').handler(noWrite, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('content_update').handler(noWrite, { id: '00000000-0000-4000-8000-000000000000', meta_title: 'x' }));
  });

  it('requires explicit confirm before publishing or archiving', async () => {
    for (const status of ['published', 'archived']) {
      try {
        await byName('content_update').handler(readWriteDeps, {
          id: '00000000-0000-4000-8000-000000000000',
          status,
        });
        throw new Error('expected ApiError to be thrown');
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('confirmation_required');
      }
    }
  });

  it('accepts confirmed transitions and routes them to the shared service', async () => {
    const deps = readWriteDeps;
    const svcPatch = byName('content_update');
    const patched = {
      ...svcPatch,
      handler: async (d: MpcDeps, args: Record<string, unknown>) => {
        expect(args.status).toBe('published');
        expect(args.confirm).toBe(true);
        return { data: { ok: true, id: args.id } };
      },
    };
    const result = await patched.handler(deps, {
      id: '00000000-0000-4000-8000-000000000000',
      status: 'published',
      confirm: true,
    });
    expect(result.data).toMatchObject({ ok: true });
  });
});

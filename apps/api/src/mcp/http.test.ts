import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ApiKeyRecord, ApiKeyScope } from '../infra/apiKeys.js';
import { ApiKeyStore } from '../infra/apiKeys.js';
import { createMcpHttpRouter } from '../mcp/http.js';
import { ScheduleService } from '../services/scheduleService.js';
import { ContentService } from '../services/contentService.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function record(scopes: ApiKeyScope[]): ApiKeyRecord {
  return {
    id: 'key-1',
    project_id: PROJECT,
    name: 'test key',
    key_prefix: 'seo_live_abcdefghijkl',
    scopes,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
  };
}

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const jobStoreList = vi.fn(async () => []);
  const fakeContainer = { sb: {}, jobStore: { list: jobStoreList } } as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { container: unknown }).container = fakeContainer;
    next();
  });
  app.use('/api/mcp', createMcpHttpRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Tiny JSON-RPC client over the streamable HTTP endpoint. */
class RpcClient {
  private sid: string | null = null;
  constructor(private readonly auth: string | null) {}

  async post(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; sid: string | null; body: unknown }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.auth) headers.authorization = this.auth;
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    const text = await res.text();
    return { status: res.status, sid, body: text ? (parseBody(text) as unknown) : null };
  }

  async delete(): Promise<number> {
    if (!this.sid) return 0;
    const res = await fetch(baseUrl, { method: 'DELETE', headers: { 'mcp-session-id': this.sid } });
    this.sid = null;
    return res.status;
  }

  async initialize(scopes: ApiKeyScope[]): Promise<void> {
    vi.spyOn(ApiKeyStore.prototype, 'authenticate').mockResolvedValue(record(scopes));
    const out = await this.post('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(out.status).toBe(200);
    expect(out.sid).toBeTruthy();
  }
}

const toolsOf = (body: unknown): string[] => {
  const result = (body as { result?: { tools?: { name: string }[] } }).result;
  return (result?.tools ?? []).map((t) => t.name);
};

/** The SDK streams single JSON-RPC messages as SSE; parse `data:` frames. */
function parseBody(text: string): unknown {
  if (!text.includes('data:')) return JSON.parse(text);
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  return data ? JSON.parse(data) : null;
}

describe('mcp http auth matrix', () => {
  it('refuses a session without an Authorization header', async () => {
    const client = new RpcClient(null);
    const spy = vi.spyOn(ApiKeyStore.prototype, 'authenticate');
    const out = await client.post('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(out.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an invalid key (authenticate returns null)', async () => {
    vi.spyOn(ApiKeyStore.prototype, 'authenticate').mockResolvedValue(null);
    const client = new RpcClient('Bearer seo_live_notakey');
    const out = await client.post('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(out.status).toBe(401);
  });

  it('refuses a revoked key (authenticate returns null for a revoked record)', async () => {
    vi.spyOn(ApiKeyStore.prototype, 'authenticate').mockResolvedValue(null);
    const client = new RpcClient('Bearer seo_live_revoked00000000000');
    const out = await client.post('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(out.status).toBe(401);
  });
});

describe('mcp http session lifecycle + tools', () => {
  it('opens a session, lists the full tool set for a read+write key, and runs a read tool', async () => {
    vi.spyOn(ContentService.prototype, 'list').mockResolvedValue({ content: [], total: 0 } as never);
    const client = new RpcClient('Bearer seo_live_abc');
    await client.initialize(['read', 'write']);

    const listed = await client.post('tools/list', {});
    expect(listed.status).toBe(200);
    const names = toolsOf(listed.body);
    expect(names).toHaveLength(14);
    expect(names).toContain('schedule_create');
    expect(names).toContain('content_update');
    expect(names).toContain('project_list');

    const ran = await client.post('tools/call', { name: 'content_list', arguments: {} });
    const result = (ran.body as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
    expect(result?.isError).toBeFalsy();
    expect(result?.content?.[0]?.text ?? '').toContain('"data"');
    expect(await client.delete()).toBe(200);
  });

  it('serves only read tools to a read-only key and blocks write tools', async () => {
    const client = new RpcClient('Bearer seo_live_readonlykey');
    await client.initialize(['read']);

    const listed = await client.post('tools/list', {});
    const names = toolsOf(listed.body);
    expect(names).toHaveLength(8);
    expect(names).toContain('content_list');
    expect(names).toContain('project_list');
    expect(names).toContain('schedule_list');
    expect(names).not.toContain('schedule_create');
    expect(names).not.toContain('schedule_reschedule');
    expect(names).not.toContain('schedule_cancel');
    expect(names).not.toContain('content_update');
    expect(names).not.toContain('content_generate');

    // A write tool that is not registered must not be callable by name.
    const call = await client.post('tools/call', {
      name: 'schedule_create',
      arguments: { project_id: PROJECT, content_id: 'x', publisher_id: 'y', scheduled_at: '2026-09-10T09:00:00Z' },
    });
    const result = (call.body as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('schedule_create not found');
    await client.delete();
  });

  it('keeps the bound project and refuses cross-project scheduling over HTTP', async () => {
    const scheduleList = vi.spyOn(ScheduleService.prototype, 'list').mockResolvedValue([]);
    const client = new RpcClient('Bearer seo_live_projectbound');
    await client.initialize(['read', 'write']);

    const call = await client.post('tools/call', {
      name: 'schedule_list',
      arguments: { project_id: '22222222-2222-4222-8222-222222222222' },
    });
    const result = (call.body as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('project_id does not match');
    expect(scheduleList).not.toHaveBeenCalled();
    await client.delete();
  });
});

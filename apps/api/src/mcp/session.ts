/**
 * Shared MCP session assembly. Both entry points (stdio via `index.ts` and the
 * streamable HTTP endpoint via `http.ts`) build exactly the same McpServer
 * from the same tool registry, bound to the same per-key context. A tool can
 * therefore never behave differently over one transport than the other.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobStore } from '../jobs/types.js';
import type { ApiKeyRecord } from '../infra/apiKeys.js';
import type { MpcDeps } from './server.js';
import { registerTools } from './server.js';

/** Project + scope context derived from an authenticated project API key. */
export function depsFromApiKey(sb: SupabaseClient, jobStore: JobStore, key: ApiKeyRecord): MpcDeps {
  return {
    sb,
    jobStore,
    projectId: key.project_id,
    userId: key.created_by,
    canRead: key.scopes.includes('read'),
    canWrite: key.scopes.includes('write'),
  };
}

/** A fresh MCP server exposing the tools the key's scopes allow. */
export function createSeoMcpServer(deps: MpcDeps): McpServer {
  const server = new McpServer({
    name: 'seo-mcp',
    version: '1.0.0',
  });
  registerTools(server as never, deps);
  return server;
}

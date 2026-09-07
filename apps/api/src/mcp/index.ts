/**
 * MCP server entry point (stdio).
 *
 * Start with an API key bound in the environment:
 *   MCP_API_KEY=seo_live_... node apps/api/dist/mcp/index.js
 *
 * A project key binds the server to one project; an account (master) key makes
 * it multi-project (every tool resolves + authorizes the target project per
 * call). The key is loaded from seo_api_keys at startup and never comes from
 * the client. The HTTP twin of this entry point lives in http.ts and shares
 * the same registry + context builder (see session.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getContainer } from '../context.js';
import { ApiKeyStore } from '../infra/apiKeys.js';
import { depsFromApiKey, createSeoMcpServer } from './session.js';
import { logger } from '../logger.js';

/**
 * Boot: resolve + validate MCP_API_KEY first (fail fast with a clear message),
 * then build the same session deps a project/account key maps to and serve over
 * stdio. Tools are shared with REST and HTTP MCP, so an agent on stdio can do
 * exactly what a browser session can - nothing more, nothing less.
 */
async function main(): Promise<void> {
  const token = process.env.MCP_API_KEY?.trim();
  if (!token) {
    logger.error('MCP_API_KEY is required (a project or account API key, seo_live_...)');
    process.exit(1);
  }
  const container = getContainer();
  const store = new ApiKeyStore(container.sb);
  const key = await store.authenticate(token);
  if (!key) {
    logger.error('MCP_API_KEY is invalid or revoked');
    process.exit(1);
  }

  const server: McpServer = createSeoMcpServer(depsFromApiKey(container.sb, container.jobStore, key));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const bound = key.project_id ? `project ${key.project_id}` : 'all your member projects';
  logger.info(`MCP server started for ${bound} (read=${key.scopes.includes('read')} write=${key.scopes.includes('write')})`);
}

main().catch((err) => {
  logger.error({ err }, 'MCP server failed to start');
  process.exit(1);
});

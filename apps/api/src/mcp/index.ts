/**
 * MCP server entry point (stdio).
 *
 * Start with a project API key bound in the environment:
 *   MCP_API_KEY=seo_live_... node apps/api/dist/mcp.js
 *
 * The key's project and scopes are loaded from seo_api_keys at startup and
 * never come from the client.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getContainer } from '../context.js';
import { ApiKeyStore } from '../infra/apiKeys.js';
import { registerTools } from './server.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
  const token = process.env.MCP_API_KEY?.trim();
  if (!token) {
    logger.error('MCP_API_KEY is required (a project API key, seo_live_...)');
    process.exit(1);
  }
  const container = getContainer();
  const store = new ApiKeyStore(container.sb);
  const key = await store.authenticate(token);
  if (!key) {
    logger.error('MCP_API_KEY is invalid or revoked');
    process.exit(1);
  }

  const deps = {
    sb: container.sb,
    jobStore: container.jobStore,
    projectId: key.project_id,
    userId: key.created_by,
    canRead: key.scopes.includes('read'),
    canWrite: key.scopes.includes('write'),
  };

  const server = new McpServer({
    name: 'seo-mcp',
    version: '1.0.0',
  });
  registerTools(server as never, deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`MCP server started for project ${key.project_id} (read=${deps.canRead} write=${deps.canWrite})`);
}

main().catch((err) => {
  logger.error({ err }, 'MCP server failed to start');
  process.exit(1);
});

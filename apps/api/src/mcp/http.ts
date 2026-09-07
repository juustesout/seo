/**
 * MCP over streamable HTTP (the remote twin of the stdio entry in index.ts).
 *
 * Mounted at /api/mcp. A client opens a session with an API key in the
 * Authorization header (`Bearer seo_live_...`); the key is resolved through
 * the same ApiKeyStore the stdio entry uses, and its scope context is bound
 * into the session exactly as in session.ts (a project key reaches one
 * project; an account/master key reaches every project the owner is a member
 * of, authorized per tool call). Every session therefore talks to the same SEO
 * Core services with the same tools.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServiceContainer } from '../context.js';
import { ApiKeyStore } from '../infra/apiKeys.js';
import type { ApiKeyRecord } from '../infra/apiKeys.js';
import { ApiError } from '../apiErrors.js';
import { depsFromApiKey, createSeoMcpServer } from './session.js';

/** A live MCP session: the tool server plus its streamable-HTTP transport, keyed by mcp-session-id. */
interface McpHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpHttpRouterOptions {
  /**
   * Resolves a bearer token to its (non-secret) key record. Defaults to the
   * ApiKeyStore backed by the request container; injectable for tests.
   */
  authenticate?: (token: string, container: ServiceContainer) => Promise<ApiKeyRecord | null>;
}

/** Pulls the bare token out of an `Authorization: Bearer ...` header (case-insensitive). */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : null;
}

/**
 * JSON-RPC error body helper. -32001 is the SDK-level server error range and
 * lets clients distinguish "the server rejected this" from a real response.
 */
function respondMpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message } });
}

/** Extracts the MCP session id header, or null when absent. */
function sessionIdOf(req: Request): string | null {
  const id = req.header('mcp-session-id');
  return id && id.length > 0 ? id : null;
}

/**
 * Build the /api/mcp router. Sessions are held in-memory per transport; the
 * router only performs authentication + session bookkeeping, never business
 * logic - every tool call goes through the same SEO Core services as REST and
 * stdio, with the project resolved from the session's API key per request.
 */
export function createMcpHttpRouter(options: McpHttpRouterOptions = {}): Router {
  const router = Router();
  const sessions = new Map<string, McpHttpSession>();
  const authenticate =
    options.authenticate ??
    ((token: string, container: ServiceContainer) => new ApiKeyStore(container.sb).authenticate(token));

  /** Map any thrown error to a JSON-RPC error response (ApiError status preserved). */
  function handleErr(res: Response, err: unknown): void {
    const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Internal error';
    const status = err instanceof ApiError && err.status >= 400 && err.status < 600 ? err.status : 500;
    respondMpcError(res, status, message);
  }

  /** Routes a message to the session transport, opening a session first. */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const existingId = sessionIdOf(req);
      if (existingId) {
        const session = sessions.get(existingId);
        if (!session) {
          respondMpcError(res, 404, 'Unknown MCP session');
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session: the project API key in the Authorization header decides
      // the project + scopes this session may touch.
      const token = bearerToken(req);
      const container = req.container;
      const key = token ? await authenticate(token, container) : null;
      if (!key) {
        respondMpcError(res, 401, 'Unauthorized: a valid API key is required');
        return;
      }

      const server = createSeoMcpServer(depsFromApiKey(container.sb, container.jobStore, key));
      let storedId: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          storedId = id;
          sessions.set(id, { server, transport });
        },
      });
      transport.onclose = () => {
        if (storedId) sessions.delete(storedId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Optional SSE stream the client can subscribe to for server messages.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const id = sessionIdOf(req);
      if (!id) {
        respondMpcError(res, 404, 'Unknown MCP session');
        return;
      }
      const session = sessions.get(id);
      if (!session) {
        respondMpcError(res, 404, 'Unknown MCP session');
        return;
      }
      await session.transport.handleRequest(req, res);
    } catch (err) {
      handleErr(res, err);
    }
  });

  // Client closes the session; state is dropped.
  router.delete('/', async (req: Request, res: Response) => {
    try {
      const id = sessionIdOf(req);
      if (!id) {
        respondMpcError(res, 404, 'Unknown MCP session');
        return;
      }
      const session = sessions.get(id);
      if (!session) {
        respondMpcError(res, 404, 'Unknown MCP session');
        return;
      }
      sessions.delete(id);
      await session.transport.close();
      res.status(200).json({ ok: true });
    } catch (err) {
      handleErr(res, err);
    }
  });

  return router;
}

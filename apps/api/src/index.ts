/**
 * HTTP server entrypoint. Loads env config, assembles the Express app and
 * starts listening on PORT. Signal handling performs a graceful shutdown:
 * stop accepting new connections, let server.close() drain in-flight requests,
 * then force-exit after a 5s backstop so a stuck keep-alive connection cannot
 * hang the process after a deploy signal (the timeout is unref'd so it alone
 * never keeps the event loop alive).
 */

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const config = loadConfig();
const app = createApp();
const port = config.env.PORT;

const server = app.listen(port, () => {
  logger.info(
    {
      port,
      configured: {
        supabase: config.supabaseConfigured,
        google: config.googleConfigured,
        dataforseo: config.dataforseoConfigured,
        qdrant: config.qdrantConfigured,
      },
    },
    'seo-api listening',
  );
});

/**
 * Graceful shutdown on SIGTERM/SIGINT. server.close() waits for in-flight
 * requests; the unref'd 5s timer is the backstop for connections that will not
 * drain on their own (long-lived/keep-alive clients) - without it the process
 * could linger in the event loop indefinitely after receiving a shutdown
 * signal. The double exit path guarantees the container orchestrator sees a
 * clean exit within a bounded window.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/** HTTP server entrypoint. */

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

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

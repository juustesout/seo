/**
 * Structured JSON logging via pino. Every line is JSON tagged `service:
 * "seo-api"` so logs from API, worker and MCP processes can be aggregated and
 * queried as one stream. Secret values are redacted by path before they can be
 * written: authorization headers, cookies and token/password-like fields are
 * censored to [REDACTED] wherever they sit in a logged object, so a stray
 * `logger.info({ user, token })` can never leak a session, an OAuth secret or
 * a stored credential into the log sink.
 */

import pino from 'pino';

/**
 * Redaction paths applied to every log line. pino matches these (glob-ish)
 * paths against the logged object tree and substitutes the censor string for
 * any value found; listing both bare `*.authorization` and the concrete
 * `req.headers.*` forms means the headers of an express request object are
 * covered whether they are logged via a child logger or as a nested object.
 */
const REDACT_PATHS = [
  '*.authorization',
  '*.cookie',
  '*.refresh_token',
  '*.access_token',
  '*.password',
  '*.client_secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Shared logger used across the API, worker and MCP process. The level comes
 * straight from the LOG_LEVEL env var (default info) because this module is
 * imported by nearly everything and must not depend on config.ts.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  base: { service: 'seo-api' },
});

/** Structural type of the pino logger, used to type logger dependencies in services. */
export type StructuredLogger = pino.Logger;

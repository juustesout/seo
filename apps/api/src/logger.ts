/** Structured JSON logging. Secret values are redacted before they can be written. */

import pino from 'pino';

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

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  base: { service: 'seo-api' },
});

export type StructuredLogger = pino.Logger;

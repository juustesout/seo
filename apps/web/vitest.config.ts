import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest stubs CSS by default, which also empties Vite's `?inline` query.
    // R5.7 reads the canonical renderer's own stylesheet with `?inline` to
    // render the document into an isolated preview frame, so process just that
    // file; every other stylesheet stays stubbed.
    css: { include: /canonicalRenderer\.css/ },
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

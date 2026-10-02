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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/test/**'],
      thresholds: {
        statements: 70,
        branches: 78,
        functions: 66,
        lines: 70,
      },
    },
  },
});

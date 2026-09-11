import { describe, expect, it } from 'vitest';
import {
  canTransition,
  assertTransition,
  ingestableStatuses,
  isTerminalStatus,
  KNOWLEDGE_STATUSES,
} from './knowledgeLifecycle.js';

describe('knowledge lifecycle transitions', () => {
  it('allows the legal pipeline transitions', () => {
    expect(canTransition('draft', 'queued')).toBe(true);
    expect(canTransition('queued', 'processing')).toBe(true);
    expect(canTransition('processing', 'ready')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('ready', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('failed', 'processing')).toBe(true);
    expect(canTransition('draft', 'deleted')).toBe(true);
    expect(canTransition('ready', 'deleted')).toBe(true);
    expect(canTransition('queued', 'queued')).toBe(true);
  });

  it('refuses the illegal transitions that would fake readiness or revive deletion', () => {
    expect(canTransition('draft', 'ready')).toBe(false);
    expect(canTransition('queued', 'ready')).toBe(false);
    expect(canTransition('failed', 'ready')).toBe(false);
    expect(canTransition('deleted', 'queued')).toBe(false);
    expect(canTransition('deleted', 'ready')).toBe(false);
    expect(canTransition('processing', 'queued')).toBe(false);
  });

  it('treats deleted as terminal', () => {
    expect(isTerminalStatus('deleted')).toBe(true);
    for (const status of KNOWLEDGE_STATUSES.filter((s) => s !== 'deleted')) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });

  it('assertTransition throws a 409 conflict on an illegal move', () => {
    expect(() => assertTransition('draft', 'ready')).toThrowError(/Cannot change/);
    try {
      assertTransition('queued', 'ready');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
      expect((err as { code?: string }).code).toBe('conflict');
    }
    expect(() => assertTransition('draft', 'queued')).not.toThrow();
  });

  it('derives the ingestable statuses from the map', () => {
    expect(ingestableStatuses().sort()).toEqual(['draft', 'failed', 'queued', 'ready']);
  });
});

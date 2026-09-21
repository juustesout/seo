/**
 * Context-aware visual intent resolution tests (R4.1).
 *
 * Pins the deterministic rules: explicit role words win, editor context breaks
 * ties, purpose words set the intent, ambiguity produces explicit candidates and
 * unsupported requests stay unsupported. No model is called and nothing mutates
 * a document.
 */
import { describe, expect, it } from 'vitest';
import { isValidVisualDesignIntent } from './visualVocabulary.js';
import {
  isVisualIntentInsertable,
  resolveVisualDesignIntent,
  visualIntentQuery,
  visualRoleFromNodeType,
  type VisualIntentContext,
} from './visualIntent.js';

function context(over: Partial<VisualIntentContext> = {}): VisualIntentContext {
  return {
    target: { kind: 'cursor', position: 3 },
    nearbyText: 'We install solar panels on residential roofs.',
    ...over,
  };
}

function resolved(instruction: string, over: Partial<VisualIntentContext> = {}) {
  const result = resolveVisualDesignIntent(instruction, context(over));
  if (result.status !== 'resolved') throw new Error(`expected resolved, got ${result.status}`);
  return result.intent;
}

describe('resolveVisualDesignIntent roles', () => {
  it('resolves an explicit hero request to hero/emphasis', () => {
    const intent = resolved('Maak de hero sterker.');
    expect(intent.role).toBe('hero');
    expect(intent.intent).toBe('emphasis');
    expect(intent.placement).toBe('full_bleed');
    expect(intent.accessibilityRequired).toBe(true);
  });

  it('resolves an explicit background request to background/atmosphere', () => {
    const intent = resolved('Gebruik een rustige achtergrond.');
    expect(intent.role).toBe('background');
    expect(intent.intent).toBe('atmosphere');
    expect(intent.accessibilityRequired).toBe(false);
  });

  it('resolves a generic image request to inline/reinforce', () => {
    const intent = resolved('Zet hier een passende afbeelding.');
    expect(intent.role).toBe('inline');
    expect(intent.intent).toBe('reinforce');
  });

  it('resolves an illustration request to illustration/explain', () => {
    const intent = resolved('Voeg een illustratie toe die dit uitlegt.');
    expect(intent.role).toBe('illustration');
    expect(intent.intent).toBe('explain');
  });

  it('resolves an explicit decorative request and marks it non-descriptive', () => {
    const intent = resolved('Plaats een decoratieve afbeelding.');
    expect(intent.role).toBe('decorative');
    expect(intent.intent).toBe('decoration');
    expect(intent.placement).toBe('overlay');
    expect(intent.accessibilityRequired).toBe(false);
  });

  it('honors an explicit aspect ratio in the instruction', () => {
    expect(resolved('Zet hier een 4:3 afbeelding.').aspectRatio).toBe('4:3');
  });
});

describe('resolveVisualDesignIntent context and precedence', () => {
  it('lets the editor target suggest a role when the instruction names none', () => {
    expect(resolved('Zet hier een afbeelding.', { targetNodeType: 'compositionHero' }).role).toBe('hero');
    expect(resolved('Zet hier een afbeelding.', { targetNodeType: 'heading' }).role).toBe('section');
    expect(visualRoleFromNodeType('compositionSection')).toBe('section');
    expect(visualRoleFromNodeType('paragraph')).toBeNull();
    expect(visualRoleFromNodeType(undefined)).toBeNull();
  });

  it('lets an explicit instruction override the contextual role', () => {
    expect(resolved('Voeg een illustratie toe.', { targetNodeType: 'compositionHero' }).role).toBe('illustration');
    expect(resolved('Zet een achtergrondafbeelding hier.', { targetNodeType: 'compositionSection' }).role).toBe('background');
  });

  it('derives the subject from the selection or the nearest heading, bounded', () => {
    expect(resolved('Zet hier een afbeelding.', { sectionHeading: 'Battery storage' }).subject).toBe('Battery storage');
    expect(resolved('Zet hier een afbeelding.', { selectedText: 'Battery storage', sectionHeading: 'Section' }).subject).toBe(
      'Battery storage',
    );
    expect(resolved('Zet hier een afbeelding.', { selectedText: 'x'.repeat(500) }).subject).toHaveLength(160);
  });

  it('builds a bounded query from the intent and context', () => {
    const intent = resolved('Zet hier een afbeelding.', { sectionHeading: 'Battery storage' });
    expect(visualIntentQuery(intent, context({ sectionHeading: 'Battery storage' }))).toContain('Battery storage');
  });
});

describe('resolveVisualDesignIntent uncertainty', () => {
  it('asks for clarification when several roles are named', () => {
    const result = resolveVisualDesignIntent('Voeg een hero en een achtergrond toe.', context());
    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') return;
    expect(result.candidates.map((candidate) => candidate.role)).toEqual(['hero', 'background']);
    expect(result.question.length).toBeGreaterThan(0);
    expect(result.candidates.every(isValidVisualDesignIntent)).toBe(true);
  });

  it('asks for clarification when a purpose is named but no role can be justified', () => {
    const result = resolveVisualDesignIntent('Maak dit meer branded.', context());
    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') return;
    expect(result.candidates.map((candidate) => candidate.role)).toEqual(['hero', 'section']);
    expect(result.candidates.every((candidate) => candidate.intent === 'brand')).toBe(true);
  });

  it('reports unsupported for a request it cannot resolve to any visual', () => {
    const result = resolveVisualDesignIntent('Maak het mooier.', context());
    expect(result).toEqual({ status: 'unsupported', reason: 'no_role_identified' });
    expect(resolveVisualDesignIntent('   ', context())).toEqual({ status: 'unsupported', reason: 'empty_instruction' });
  });

  it('marks which resolved roles R4.1 can actually place', () => {
    expect(isVisualIntentInsertable(resolved('Voeg een illustratie toe.'))).toBe(true);
    expect(isVisualIntentInsertable(resolved('Maak de hero sterker.'))).toBe(false);
    expect(isVisualIntentInsertable(resolved('Gebruik een rustige achtergrond.'))).toBe(false);
  });
});

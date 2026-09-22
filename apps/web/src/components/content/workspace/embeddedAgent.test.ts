import { describe, expect, it } from 'vitest';
import type { AgentRun, ImageInsertionContext, InsertImageOperation } from '@seo/contracts';
import { ApiRequestError } from '../../../lib/api';
import {
  embeddedAgentContextHint,
  embeddedAgentOutcomeFromError,
  embeddedAgentOutcomeFromRun,
  embeddedAgentRunPath,
  embeddedAgentSubmission,
  embeddedAgentWantsImageContext,
  visualIntentLabel,
  visualRoleLabel,
  type EmbeddedAgentSubmissionInput,
} from './embeddedAgent';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'ar_22222222-2222-4222-8222-222222222222';

const IMAGE_CONTEXT: ImageInsertionContext = {
  revision: 'rev1:0123456789abcdef',
  document: { version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels' }] }] },
  target: { kind: 'cursor', position: 3 },
  nearbyText: 'We install solar panels on roofs.',
};

const INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'cursor', position: 3 },
  image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
};

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    kind: 'design',
    projectId: PROJECT,
    status: 'queued',
    input: { mode: 'intent', intent: { instruction: 'x', projectId: PROJECT } },
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

describe('embeddedAgentSubmission', () => {
  it('targets the durable run endpoint with content_id for an existing document', () => {
    const input: EmbeddedAgentSubmissionInput = {
      projectId: PROJECT,
      contentId: CONTENT,
      revision: 'rev1:abc',
      instruction: '  Zet hier een passende afbeelding.  ',
    };
    expect(embeddedAgentSubmission(input)).toEqual({
      path: `/projects/${PROJECT}/designer/runs`,
      body: { mode: 'intent', instruction: 'Zet hier een passende afbeelding.', content_id: CONTENT },
    });
  });

  it('uses base_revision for a not-yet-persisted document', () => {
    expect(
      embeddedAgentSubmission({ projectId: PROJECT, contentId: null, revision: 'rev1:new', instruction: 'Start' }),
    ).toEqual({
      path: `/projects/${PROJECT}/designer/runs`,
      body: { mode: 'intent', instruction: 'Start', base_revision: 'rev1:new' },
    });
  });

  it('carries the editor context for an image insertion on an existing document', () => {
    expect(
      embeddedAgentSubmission({
        projectId: PROJECT,
        contentId: CONTENT,
        revision: 'rev1:abc',
        instruction: 'Zet hier een passende afbeelding.',
        imageContext: IMAGE_CONTEXT,
      }),
    ).toEqual({
      path: `/projects/${PROJECT}/designer/runs`,
      body: {
        mode: 'intent',
        instruction: 'Zet hier een passende afbeelding.',
        content_id: CONTENT,
        editor_context: IMAGE_CONTEXT,
      },
    });
  });

  it('never attaches an editor context to a creation request', () => {
    const submission = embeddedAgentSubmission({
      projectId: PROJECT,
      contentId: null,
      revision: 'rev1:new',
      instruction: 'Start',
      imageContext: IMAGE_CONTEXT,
    });
    expect(submission?.body).not.toHaveProperty('editor_context');
  });

  it('refuses a blank instruction, a missing project or a creation without a revision', () => {
    expect(embeddedAgentSubmission({ projectId: PROJECT, contentId: CONTENT, revision: null, instruction: '   ' })).toBeNull();
    expect(embeddedAgentSubmission({ projectId: '', contentId: CONTENT, revision: null, instruction: 'x' })).toBeNull();
    expect(embeddedAgentSubmission({ projectId: PROJECT, contentId: null, revision: null, instruction: 'x' })).toBeNull();
  });
});

describe('embeddedAgentRunPath', () => {
  it('reads one run under the project', () => {
    expect(embeddedAgentRunPath(PROJECT, RUN_ID)).toBe(`/projects/${PROJECT}/designer/runs/${RUN_ID}`);
  });
});

describe('embeddedAgentContextHint', () => {
  it('describes the current text selection or the document, never a precise block', () => {
    expect(embeddedAgentContextHint({ type: 'text', from: 0, to: 4 })).toBe('Working with the selected text.');
    expect(embeddedAgentContextHint({ type: 'node', nodeType: 'image' })).toBe('Working with the selected block.');
    expect(embeddedAgentContextHint({ type: 'cursor', from: 2, to: 2 })).toBe('Working at the cursor.');
    expect(embeddedAgentContextHint({ type: 'none' })).toBe('Working with the current document.');
  });
});

describe('embeddedAgentOutcomeFromRun', () => {
  it('reports queued and running as working without exposing status names', () => {
    expect(embeddedAgentOutcomeFromRun(run({ status: 'queued' }))).toEqual({
      kind: 'working',
      message: 'The Agent is working on your request…',
    });
    expect(embeddedAgentOutcomeFromRun(run({ status: 'running' })).kind).toBe('working');
  });

  it('reports a succeeded run as a proposal that did not change the document', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] } },
      }),
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.message).toContain('Your document is unchanged');
  });

  it('flags a succeeded run whose review found issues', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: {
          version: 1,
          baseRevision: 'rev1:abc',
          document: { version: 1, blocks: [] },
          review: { ok: false, errors: [{ code: 'x', message: 'y' }], warnings: [] },
        },
      }),
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.message).toContain('flagged issues');
  });

  it('reports an unwired capability as unsupported', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({ status: 'failed', error: { code: 'visual_design_unavailable', message: 'Not wired yet.', retryable: false } }),
    );
    expect(outcome).toEqual({ kind: 'unsupported', message: "This action isn't available yet." });
  });

  it('reports other failures as errors with the backend retryability and no internal copy', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({ status: 'failed', error: { code: 'ai_error', message: 'writer.freeText failed.', retryable: true } }),
    );
    expect(outcome).toEqual({ kind: 'error', message: "The Agent couldn't complete that request.", canRetry: true });
    expect(outcome.message).not.toContain('writer.freeText');
  });

  it('never marks a failed run without retryability as retryable', () => {
    const outcome = embeddedAgentOutcomeFromRun(run({ status: 'failed', error: { code: 'invalid_output', message: 'Nope.' } }));
    expect(outcome).toMatchObject({ kind: 'error', canRetry: false });
  });

  it('surfaces a succeeded run carrying an insert_image operation as a reviewable candidate', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: INSERTION },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'insertion', operation: INSERTION });
  });

  it('reports a no-candidate image run as an honest empty result', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({ status: 'failed', error: { code: 'image_insertion_no_candidate', message: 'none', retryable: false } }),
    );
    expect(outcome).toEqual({ kind: 'empty', message: "I couldn't find a suitable image for this section." });
  });

  it('reports a stale editor context as a retryable error without internal copy', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({ status: 'failed', error: { code: 'stale_editor_context', message: 'expected rev1:x actual rev1:y', retryable: true } }),
    );
    expect(outcome).toMatchObject({ kind: 'error', canRetry: true });
    expect(outcome.message).toContain('document changed');
  });
});

describe('embeddedAgentOutcomeFromError', () => {
  it('treats authorization failures as non-retryable errors', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('forbidden', 'No access', 403))).toEqual({
      kind: 'error',
      message: "You don't have access to ask the Agent here.",
      canRetry: false,
    });
  });

  it('treats a 503 or an *_unavailable code as unsupported', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('service_unavailable', 'Down', 503))).toMatchObject({
      kind: 'unsupported',
    });
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('writer_revise_unavailable', 'Not wired', 500))).toMatchObject({
      kind: 'unsupported',
    });
  });

  it('keeps validation and server failures retryable', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('validation_error', 'Bad input', 400))).toMatchObject({
      canRetry: true,
    });
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('server_error', 'Boom', 500))).toMatchObject({ canRetry: true });
  });

  it('gives a transport failure a plain message', () => {
    expect(embeddedAgentOutcomeFromError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'error',
      message: 'Could not reach the Agent. Check your connection and try again.',
      canRetry: true,
    });
  });

  it('maps the typed image-insertion failures to product language', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('image_insertion_no_candidate', 'none', 422))).toEqual({
      kind: 'empty',
      message: "I couldn't find a suitable image for this section.",
    });
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('stale_editor_context', 'expected/actual', 409))).toMatchObject({
      kind: 'error',
      canRetry: true,
    });
    expect(
      embeddedAgentOutcomeFromError(new ApiRequestError('image_insertion_requires_saved_document', 'save first', 422)),
    ).toMatchObject({ kind: 'error', canRetry: false });
  });
});

describe('embeddedAgent visual intent (R4.1)', () => {
  it('labels resolved roles and intents in product language', () => {
    expect(visualRoleLabel('illustration')).toBe('Illustration');
    expect(visualRoleLabel('hero')).toBe('Hero visual');
    expect(visualRoleLabel(undefined)).toBeNull();
    expect(visualIntentLabel('explain')).toBe('explains');
    expect(visualIntentLabel(undefined)).toBeNull();
  });

  it('keeps the resolved visual intent on the reviewable candidate', () => {
    const withVisual: InsertImageOperation = { ...INSERTION, visual: { role: 'illustration', intent: 'explain' } };
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: withVisual },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'insertion', operation: withVisual });
  });

  it('maps an unsupported role to product language without echoing backend internals', () => {
    const outcome = embeddedAgentOutcomeFromError(
      new ApiRequestError('visual_role_unsupported', 'role=logo not hostable', 422),
    );
    expect(outcome.kind).toBe('unsupported');
    expect(outcome.message).toContain('inline image');
    expect(outcome.message).not.toContain('not hostable');
  });

  it('maps an ambiguous request to a clarification instead of a guess', () => {
    expect(
      embeddedAgentOutcomeFromError(new ApiRequestError('visual_intent_needs_clarification', 'which role?', 422)),
    ).toEqual({
      kind: 'clarification',
      message:
        'What kind of visual do you want here: an inline image, a section image, a hero image, a background image or an illustration?',
    });
  });

  it('reports an unresolvable visual request as unsupported', () => {
    expect(
      embeddedAgentOutcomeFromRun(
        run({ status: 'failed', error: { code: 'visual_intent_unsupported', message: 'no role', retryable: false } }),
      ),
    ).toMatchObject({ kind: 'unsupported' });
  });
});

describe('embeddedAgent section visuals (R4.2)', () => {
  it('asks the user to anchor the request when no section is found', () => {
    expect(
      embeddedAgentOutcomeFromError(new ApiRequestError('section_target_unresolved', 'no heading', 422)),
    ).toEqual({
      kind: 'clarification',
      message: "I couldn't find a section heading here. Put the cursor under a section heading and try again.",
    });
  });

  it('reports an already-imaged section as a neutral note, not a failure', () => {
    expect(
      embeddedAgentOutcomeFromError(new ApiRequestError('section_image_already_present', 'has image', 422)),
    ).toEqual({
      kind: 'empty',
      message: 'This section already has an image. Remove or replace it first, then ask again.',
    });
  });

  it('maps an unsupported section placement to product language', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'failed',
        error: { code: 'visual_placement_unsupported', message: 'full_bleed unsupported', retryable: false },
      }),
    );
    expect(outcome.kind).toBe('unsupported');
    expect(outcome.message).toContain('contained');
    expect(outcome.message).not.toContain('full_bleed');
  });

  it('describes a section candidate as anchored after the heading', () => {
    const sectionInsertion: InsertImageOperation = {
      ...INSERTION,
      target: { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' },
      visual: { role: 'section', intent: 'reinforce', placement: 'contained' },
    };
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: sectionInsertion },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'insertion', operation: sectionInsertion });
    expect(outcome.message).toContain('section');
  });
});

describe('embeddedAgent hero visuals (R4.3)', () => {
  it('asks the user to anchor the request when no hero is found', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('hero_target_unresolved', 'no hero', 422))).toEqual({
      kind: 'clarification',
      message: "I couldn't find a hero area on this page. Add a hero section or a heading at the top and try again.",
    });
  });

  it('reports an already-imaged hero as a neutral note, not a failure', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('hero_image_already_present', 'has image', 422))).toEqual({
      kind: 'empty',
      message: 'This hero already has an image. Remove or replace it first, then ask again.',
    });
  });

  it('describes a hero candidate as landing in the hero', () => {
    const heroInsertion: InsertImageOperation = {
      ...INSERTION,
      target: { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' },
      visual: { role: 'hero', intent: 'emphasis', placement: 'full_bleed' },
    };
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: heroInsertion },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'insertion', operation: heroInsertion });
    expect(outcome.message).toContain('hero');
  });

  it('maps an unsupported hero placement to product language', () => {
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'failed',
        error: { code: 'visual_placement_unsupported', message: 'overlay unsupported', retryable: false },
      }),
    );
    expect(outcome.kind).toBe('unsupported');
    expect(outcome.message).toContain('full-width hero');
    expect(outcome.message).not.toContain('overlay');
  });
});

describe('embeddedAgent background visuals (R4.4)', () => {
  it('asks the user to anchor the request when no host region is found', () => {
    expect(embeddedAgentOutcomeFromError(new ApiRequestError('background_target_unresolved', 'no region', 422))).toEqual({
      kind: 'clarification',
      message: "I couldn't find a section or hero for the background. Put the cursor in a section or the hero and try again.",
    });
  });

  it('reports an already-imaged host region as a neutral note, not a failure', () => {
    expect(
      embeddedAgentOutcomeFromError(new ApiRequestError('background_image_already_present', 'has image', 422)),
    ).toEqual({
      kind: 'empty',
      message: 'This area already has an image. Remove or replace it first, then ask again.',
    });
  });

  it('labels the background role and describes its candidate in the host area', () => {
    expect(visualRoleLabel('background')).toBe('Background visual');
    const backgroundInsertion: InsertImageOperation = {
      ...INSERTION,
      target: { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' },
      visual: { role: 'background', intent: 'atmosphere', placement: 'full_bleed' },
    };
    const outcome = embeddedAgentOutcomeFromRun(
      run({
        status: 'succeeded',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: backgroundInsertion },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'insertion', operation: backgroundInsertion });
    expect(outcome.message).toContain('background');
  });
});

describe('embeddedAgentWantsImageContext', () => {
  it('routes plain image requests and explicit hero/background requests through the image path', () => {
    expect(embeddedAgentWantsImageContext('Zet hier een passende afbeelding.')).toBe(true);
    expect(embeddedAgentWantsImageContext('Geef deze sectie een passende afbeelding.')).toBe(true);
    expect(embeddedAgentWantsImageContext('Maak de hero sterker.')).toBe(true);
    expect(embeddedAgentWantsImageContext('Maak de hero-afbeelding sterker.')).toBe(true);
    expect(embeddedAgentWantsImageContext('Gebruik een rustige achtergrond.')).toBe(true);
    expect(embeddedAgentWantsImageContext('Gebruik een rustige achtergrond voor de hero.')).toBe(true);
  });

  it('leaves ordinary and unsupported-role instructions to the Designer run', () => {
    expect(embeddedAgentWantsImageContext('Add a section')).toBe(false);
    expect(embeddedAgentWantsImageContext('Maak het mooier.')).toBe(false);
    expect(embeddedAgentWantsImageContext('Geef achtergrondinformatie over zonnepanelen.')).toBe(false);
  });
});

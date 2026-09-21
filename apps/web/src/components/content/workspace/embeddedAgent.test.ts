import { describe, expect, it } from 'vitest';
import type { AgentRun, ImageInsertionContext, InsertImageOperation } from '@seo/contracts';
import { ApiRequestError } from '../../../lib/api';
import {
  embeddedAgentContextHint,
  embeddedAgentOutcomeFromError,
  embeddedAgentOutcomeFromRun,
  embeddedAgentRunPath,
  embeddedAgentSubmission,
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

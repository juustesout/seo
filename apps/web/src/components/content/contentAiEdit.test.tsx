/**
 * Cosmos AI editor flow tests.
 *
 * Pins the two safety-critical client behaviours:
 *   1. the exact selection range/text is what gets sent (and nothing is sent
 *      for an empty selection), and
 *   2. applying a proposal replaces only the selected range - text outside it
 *      survives and the document is never replaced wholesale.
 * Also covers the review-before-apply panel (Apply/Reject) and the shared
 * operation labels. A real headless Tiptap editor is used for the ranges.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { ContentAiEditOperation, ContentAiEditResponseDto } from '@seo/contracts';
import { AI_EDIT_OPERATION_LABELS } from './contentAi';
import { ContentAiEditPanel } from './ContentAiEditPanel';
import { applyAiEditToEditor, readEditorSelection, type AiEditProposal } from './contentAiEditFlow';

const editors: Editor[] = [];

function makeEditor(content = '<p>Hello world</p><p>Second line</p>'): Editor {
  const editor = new Editor({ extensions: [StarterKit], content });
  editors.push(editor);
  return editor;
}

function proposal(overrides: Partial<AiEditProposal> = {}): AiEditProposal {
  return {
    operation: 'replace_selection',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Howdy' }] }],
    reason: 'tightened',
    model: 'openai',
    range: { from: 1, to: 6 },
    requested: 'rewrite',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  while (editors.length > 0) editors.pop()!.destroy();
});

describe('readEditorSelection', () => {
  it('returns the exact range and text of a non-empty selection', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(readEditorSelection(editor)).toEqual({ from: 1, to: 6, text: 'Hello' });
  });

  it('returns null for an empty selection and for no editor', () => {
    const editor = makeEditor();
    editor.commands.setTextSelection({ from: 3, to: 3 });
    expect(readEditorSelection(editor)).toBeNull();
    expect(readEditorSelection(null)).toBeNull();
  });
});

describe('applyAiEditToEditor', () => {
  it('replaces only the selected range and keeps the rest of the document', () => {
    const editor = makeEditor();
    const applied = applyAiEditToEditor(editor, proposal());
    expect(applied).toBe(true);
    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
    expect(text).toContain('Howdy');
    expect(text).toContain('Second line');
    expect(text).not.toContain('Hello');
  });

  it('does nothing without an editor or proposal', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    expect(applyAiEditToEditor(editor, null)).toBe(false);
    expect(applyAiEditToEditor(null, proposal())).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it('leaves the document untouched when a stale range is out of bounds', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    expect(() => applyAiEditToEditor(editor, proposal({ range: { from: 9999, to: 10000 } }))).not.toThrow();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('ContentAiEditPanel', () => {
  const dto: ContentAiEditResponseDto = {
    operation: 'replace_selection',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tighter copy.' }] }],
    reason: 'Made it clearer',
    model: 'openai',
    knowledge: [{ name: 'Style guide', excerpt: 'Use active voice.' }],
  };

  it('previews the proposal and reports Apply / Reject', () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    render(<ContentAiEditPanel proposal={dto} operationLabel="Rewrite" onApply={onApply} onReject={onReject} />);

    expect(screen.getByText('AI edit — Rewrite')).toBeTruthy();
    expect(screen.getByText('Made it clearer')).toBeTruthy();
    expect(screen.getByText('Tighter copy.')).toBeTruthy();
    expect(screen.getByText(/1 knowledge source/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe('AI_EDIT_OPERATION_LABELS', () => {
  it('labels every editor operation', () => {
    const operations: ContentAiEditOperation[] = ['rewrite', 'improve', 'shorten', 'expand', 'ask'];
    for (const operation of operations) {
      expect(AI_EDIT_OPERATION_LABELS[operation]).toBeTruthy();
    }
    expect(AI_EDIT_OPERATION_LABELS.ask).toBe('Ask AI');
  });
});

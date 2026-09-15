/**
 * Pure helpers for the structured, selection-scoped AI edit flow.
 *
 * Kept out of the view so the two safety-critical steps are unit-testable:
 * reading the exact selection range to send, and applying a validated proposal
 * back over that same range only (never the whole document).
 */
import type { Editor } from '@tiptap/react';
import type { ContentAiEditOperation, ContentAiEditResponseDto } from '@seo/contracts';

export interface EditorSelection {
  from: number;
  to: number;
  text: string;
}

export interface AiEditProposal extends ContentAiEditResponseDto {
  range: { from: number; to: number };
  requested: ContentAiEditOperation;
}

/** The current non-empty selection, or null when nothing is selected. */
export function readEditorSelection(editor: Editor | null): EditorSelection | null {
  if (!editor) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty || from >= to) return null;
  return { from, to, text: editor.state.doc.textBetween(from, to, '\n') };
}

/**
 * Applies a proposal with a normal editor transaction over the selected range
 * only, so autosave picks it up and Undo stays available. Returns false when
 * there is no editor or no proposal.
 */
export function applyAiEditToEditor(editor: Editor | null, proposal: AiEditProposal | null): boolean {
  if (!editor || !proposal) return false;
  const { from, to } = proposal.range;
  if (from < 0 || to > editor.state.doc.content.size || from >= to) return false;
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, proposal.content)
    .run();
  return true;
}

/**
 * Embedded Agent entry surface (R2.1).
 *
 * The single in-editor doorway to the Designer Agent. It reads identity,
 * revision, dirty state and selection from `useEditorContext`, so it needs no
 * project or document selector and never duplicates editor state, then delegates
 * the whole interaction to `useEmbeddedAgent`. It is mounted through the reserved
 * `InlineAssistantSlot` and opened with Ctrl/Cmd+K or the "Ask Agent" trigger.
 *
 * Focus: opening focuses the instruction field; closing returns focus to the
 * "Ask Agent" trigger, a predictable control that is always present after close.
 */
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useEditorContext, useEditorContextSnapshot } from '../editor/EditorContext';
import { useEditorSelection } from '../editor/EditorSelectionContext';
import { embeddedAgentContextHint } from './embeddedAgent';
import { EmbeddedAgentInput } from './EmbeddedAgentInput';
import { EmbeddedAgentStatus } from './EmbeddedAgentStatus';
import { useEmbeddedAgent } from './useEmbeddedAgent';

export interface EmbeddedAgentEntryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  configured: boolean;
  onSaveNow: () => void;
  pollMs?: number;
  /** Opens the workspace rail so the applied insertion is visible and selectable. */
  onRevealInsertion?: () => void;
}

export function EmbeddedAgentEntry({
  open,
  onOpenChange,
  canEdit,
  configured,
  onSaveNow,
  pollMs,
  onRevealInsertion,
}: EmbeddedAgentEntryProps) {
  const snapshot = useEditorContextSnapshot();
  const context = useEditorContext();
  const selectionContext = useEditorSelection();
  const agent = useEmbeddedAgent({
    projectId: snapshot?.projectId ?? '',
    contentId: snapshot?.contentId ?? null,
    revision: snapshot?.document.revision ?? null,
    dirty: snapshot?.document.dirty ?? false,
    ready: snapshot?.ready ?? false,
    unrepresentable: snapshot?.document.unrepresentable ?? false,
    canEdit,
    configured,
    pollMs,
    ...(context
      ? {
          buildImageInsertionContext: context.buildImageInsertionContext,
          applyImageInsertion: context.applyImageInsertion,
        }
      : {}),
    onInserted: () => {
      selectionContext?.requestReveal();
      onRevealInsertion?.();
    },
  });

  const triggerRef = useRef<HTMLSpanElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open && wasOpenRef.current) triggerRef.current?.querySelector('button')?.focus();
    wasOpenRef.current = open;
  }, [open]);

  const contextHint = embeddedAgentContextHint(snapshot?.selection ?? { type: 'none' });

  const close = () => {
    agent.close();
    onOpenChange(false);
  };

  return (
    <div className="grid gap-2">
      {open ? (
        <>
          <EmbeddedAgentInput
            instruction={agent.instruction}
            onInstructionChange={agent.setInstruction}
            onSubmit={agent.submit}
            onCancel={close}
            onSaveNow={onSaveNow}
            canSubmit={agent.canSubmit}
            busy={agent.state.status === 'submitting' || agent.state.status === 'working'}
            dirty={snapshot?.document.dirty ?? false}
            contextHint={contextHint}
            blockedReason={agent.blockedReason}
          />
          <EmbeddedAgentStatus
            state={agent.state}
            onRetry={agent.retry}
            onInsert={agent.insert}
            onGenerate={agent.generate}
            onCancel={close}
          />
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span ref={triggerRef} className="inline-flex">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpenChange(true)}
              data-testid="embedded-agent-open"
            >
              Ask Agent
            </Button>
          </span>
          <span className="text-xs text-muted-foreground">Describe a change in this document.</span>
        </div>
      )}
    </div>
  );
}

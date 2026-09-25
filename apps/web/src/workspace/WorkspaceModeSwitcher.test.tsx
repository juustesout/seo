/**
 * R5.3 mode switcher: three modes, active styling via aria-pressed, and roving
 * keyboard focus so the workspace is usable without a pointer.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceModeSwitcher, normalizeWorkspaceMode, type WorkspaceMode } from './WorkspaceModeSwitcher';

describe('normalizeWorkspaceMode', () => {
  it('accepts the three real modes and defaults anything else to editor', () => {
    expect(normalizeWorkspaceMode('composer')).toBe('composer');
    expect(normalizeWorkspaceMode('designer')).toBe('designer');
    expect(normalizeWorkspaceMode('editor')).toBe('editor');
    expect(normalizeWorkspaceMode(null)).toBe('editor');
    expect(normalizeWorkspaceMode('nope')).toBe('editor');
  });
});

describe('WorkspaceModeSwitcher', () => {
  it('marks only the active mode selected and clickable', () => {
    const onChange = vi.fn();
    render(<WorkspaceModeSwitcher mode="editor" onChange={onChange} />);
    expect(screen.getByTestId('workspace-mode-editor').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('workspace-mode-composer').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    expect(onChange).toHaveBeenCalledWith('designer');
  });

  it('moves and activates a mode with arrow keys', () => {
    const onChange = vi.fn();
    render(<WorkspaceModeSwitcher mode="editor" onChange={onChange} />);
    const tablist = screen.getByTestId('workspace-mode-switcher');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('composer');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('designer');
  });

  it('switches the active mode in a controlled parent', () => {
    function Harness() {
      const [mode, setMode] = useState<WorkspaceMode>('editor');
      return <WorkspaceModeSwitcher mode={mode} onChange={setMode} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    expect(screen.getByTestId('workspace-mode-composer').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('workspace-mode-editor').getAttribute('aria-pressed')).toBe('false');
  });

  it('is inert when no change handler is supplied', () => {
    render(<WorkspaceModeSwitcher mode="editor" />);
    fireEvent.click(screen.getByTestId('workspace-mode-designer'));
    expect(screen.getByTestId('workspace-mode-editor').getAttribute('aria-pressed')).toBe('true');
  });
});

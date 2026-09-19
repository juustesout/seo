/**
 * Effective design-system resolution (Stage 8E.6 Phase 3.4).
 *
 * The provider is the web's single source of the tokens a CanonicalDocument
 * renders against: it reads the project's Cosmos settings and expands them
 * through the shared resolver, so the renderer and the editor canvas can never
 * disagree. The transport module is mocked; no live calls are made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_DESIGN_SYSTEM } from '@seo/contracts';
import { DesignSystemProvider, useDesignSystem } from './designSystem';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('./api', () => ({ api: (...args: unknown[]) => apiMock(...args) }));

function Probe() {
  const designSystem = useDesignSystem();
  return <span data-testid="primary">{designSystem.colors.primary}</span>;
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('useDesignSystem', () => {
  it('falls back to the safe defaults outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('primary').textContent).toBe(DEFAULT_DESIGN_SYSTEM.colors.primary);
  });
});

describe('DesignSystemProvider', () => {
  it('resolves the project Cosmos design tokens for the subtree', async () => {
    apiMock.mockResolvedValue({ design: { colors: { primary: '#123456' } } });
    render(
      <DesignSystemProvider projectId="p-1">
        <Probe />
      </DesignSystemProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('primary').textContent).toBe('#123456'));
    expect(apiMock).toHaveBeenCalledWith('/projects/p-1/cosmos');
  });

  it('falls back to the defaults when Cosmos has no design tokens', async () => {
    apiMock.mockResolvedValue({ identity: { name: 'Acme' } });
    render(
      <DesignSystemProvider projectId="p-1">
        <Probe />
      </DesignSystemProvider>,
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(screen.getByTestId('primary').textContent).toBe(DEFAULT_DESIGN_SYSTEM.colors.primary);
  });

  it('falls back to the defaults when the Cosmos request fails', async () => {
    apiMock.mockRejectedValue(new Error('offline'));
    render(
      <DesignSystemProvider projectId="p-1">
        <Probe />
      </DesignSystemProvider>,
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(screen.getByTestId('primary').textContent).toBe(DEFAULT_DESIGN_SYSTEM.colors.primary);
  });
});

/**
 * Effective design system (Stage 8E.6 Phase 3.4).
 *
 * The web has exactly one way to obtain the design system a CanonicalDocument
 * renders against: the project's Cosmos settings, expanded by the shared
 * `resolveDesignSystem` contract. The provider resolves it once per project and
 * both the CanonicalRenderer and the Content Studio editor canvas read it from
 * context, so preview and editing can never disagree on the tokens that apply.
 *
 * Using context (with the safe built-in defaults as its default value) means a
 * component rendered outside a provider - or before Cosmos resolves - still
 * renders deterministically with the defaults.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_DESIGN_SYSTEM, effectiveDesignSystem, type DesignSystem } from '@seo/contracts';
import { api } from './api';
import { useAsync } from './ui';

/**
 * Resolves the project's effective design system from its Cosmos settings.
 * Falls back to the safe built-in defaults while loading, when Cosmos is
 * unconfigured, or when the project has no design tokens.
 */
export function useProjectDesignSystem(projectId: string): DesignSystem {
  const state = useAsync<unknown>(() => api(`/projects/${projectId}/cosmos`), [projectId]);
  return useMemo(() => effectiveDesignSystem(state.data ?? undefined), [state.data]);
}

const DesignSystemContext = createContext<DesignSystem>(DEFAULT_DESIGN_SYSTEM);

/** Resolves the project design system once and shares it with the subtree. */
export function DesignSystemProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const designSystem = useProjectDesignSystem(projectId);
  return <DesignSystemContext.Provider value={designSystem}>{children}</DesignSystemContext.Provider>;
}

/** The effective design system for the current project (defaults outside a provider). */
export function useDesignSystem(): DesignSystem {
  return useContext(DesignSystemContext);
}

/**
 * Canonical, read-only project metadata the workspace header shows (R5.9).
 *
 * It is derived from the account's `/me` payload (the same source the project
 * switcher and role gating use), so the workspace consumes the canonical project
 * identity instead of owning or re-fetching it. No provider or account state
 * belongs here.
 */
export interface WorkspaceProjectInfo {
  /** Canonical project name from `/me`; consumed, never minted here. */
  name: string;
  websiteUrl?: string | null;
  /** Canonical integration counts from `/me` (no extra request). */
  connectedIntegrations?: number;
  totalIntegrations?: number;
}

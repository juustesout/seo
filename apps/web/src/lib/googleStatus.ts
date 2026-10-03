/**
 * Derives one honest status per Google product from the existing per-project
 * connection states. The three products (Search Console, Analytics, Ads) all
 * expose `{ google: { connected, error }, current }`; the UI must tell apart
 * "the account has not authorized Google" from "authorized but this project has
 * not chosen a property/customer" from "fully ready", and must not surface raw
 * OAuth/API error text in the overview.
 */

export type GoogleProductState = 'not_connected' | 'needs_attention' | 'needs_configuration' | 'connected';

export interface GoogleStateLike {
  google: { connected: boolean; error: string | null };
  current: unknown | null;
}

export function googleProductState(state: GoogleStateLike): GoogleProductState {
  if (!state.google.connected) return 'not_connected';
  if (state.google.error) return 'needs_attention';
  if (!state.current) return 'needs_configuration';
  return 'connected';
}

export const GOOGLE_STATE_LABEL: Record<GoogleProductState, string> = {
  not_connected: 'Not connected',
  needs_attention: 'Connection needs attention',
  needs_configuration: 'Not configured for this project',
  connected: 'Connected',
};

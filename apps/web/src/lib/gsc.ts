/**
 * Account-level Google Search Console helpers.
 *
 * The GSC OAuth connection is owned by the user's account, not by a single
 * project (see CLAUDE.md): it is authorized once and any of the account's
 * projects can then attach one of the resulting properties. The browser never
 * holds the Google token - it asks the API for an authorization URL and hands
 * the whole tab to Google; the server stores the encrypted token after the
 * OAuth callback. These helpers therefore only ever deal in connect URLs.
 */
import { api } from './api';

/** Start the account-level Google OAuth flow in this tab. */
export async function connectGoogle(): Promise<void> {
  const r = await api<{ url: string }>('/account/gsc/connect-url');
  window.location.href = r.url;
}

/** Fetch the GSC connect URL only (callers may open it in a new tab). */
export async function googleConnectUrl(): Promise<string> {
  const r = await api<{ url: string }>('/account/gsc/connect-url');
  return r.url;
}

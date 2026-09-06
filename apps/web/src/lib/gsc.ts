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

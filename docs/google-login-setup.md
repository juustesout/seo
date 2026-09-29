# Google login setup

P1 adds a "Continue with Google" action to the existing `AuthScreen`
(`apps/web/src/App.tsx`). It uses the application's existing Supabase Auth
client and `supabase.auth.signInWithOAuth({ provider: 'google' })`; it does not
introduce a second auth system, a second OAuth client or any Google token
handling in the app. On return, the existing session bootstrap,
`onAuthStateChange` subscription, `/me` load, project selection, routing and
logout all apply unchanged.

The redirect target is the running app's own origin (`window.location.origin`),
never a hardcoded URL. No Google client ID or secret is present in the
repository or the browser bundle.

## External configuration required

1. **Supabase Auth: enable the Google provider.** In the Supabase dashboard
   (Authentication -> Providers -> Google), enable Google and paste the Google
   OAuth client ID and client secret. These live only in the Supabase project.
2. **Google Cloud: OAuth client.** Create/confirm a Web application OAuth
   client and add the Supabase callback as an authorized redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Supabase Auth: site and redirect URLs.** Set the Site URL and add
   `https://oldskoolseo.com` to the redirect allow-list so `redirectTo` returns
   to the production app. Use the production domain as-is; do not invent
   additional redirect URLs.

## Scope separation

Google login (this setup) and Google Search Console authorization are separate
flows with separate credentials:

- Login uses the Supabase Google provider and is identity only.
- GSC uses the platform's own server-side Google OAuth client
  (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the API, plus
  `CREDENTIALS_ENCRYPTION_KEY`) and the `webmasters.readonly` scope, connecting
  at the account level after login.

Enabling Google login does not modify the GSC OAuth flow, its scopes, callback
routes, encrypted token storage, token refresh or property discovery.

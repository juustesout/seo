# Platform administrator bootstrap (P3)

How an operator becomes a platform administrator, and how that grant is
removed. Platform administration is a **separate trust boundary** from project
membership: project `owner`/`admin` roles never grant it, and it is never
derived from a client claim or an email comparison.

## What a platform administrator can do

Read-only operational views under `/api/admin` and the `/admin` area:

- `GET /api/admin/overview` - entity counts, job health, current-month usage
  events and recent jobs.
- `GET /api/admin/users` - users with account association and project count.
- `GET /api/admin/accounts` - accounts with owner and reach.
- `GET /api/admin/projects` - projects with owning account and member count.
- `GET /api/admin/usage` - cross-account usage aggregate.

There is no billing, no destructive account/project control and no
self-service grant. No secrets, tokens, credentials, API key material or job
payloads are returned by any of these.

## The registry

Platform administrators are rows in `public.seo_platform_admins`, keyed by the
authenticated Supabase **user id**:

```sql
create table public.seo_platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);
```

RLS is enabled with **no policies**, table privileges are revoked from
`public`/`anon`/`authenticated`, and only `service_role` may read or write it.
The read RPCs are `security definer`, re-verify the actor with
`seo_assert_platform_admin`, and are executable only by `service_role`.

## Grant

Run this in the Supabase SQL editor (or any session with the `service_role`,
`postgres` or `supabase_admin` role) against the target project. This is the
only supported provisioning path - do not add an API or UI route that writes
this table.

```sql
-- Replace with the user's UUID. Find it in Authentication > Users, or:
--   select id from auth.users where email = 'operator@example.com';
insert into public.seo_platform_admins (user_id, created_by)
values ('00000000-0000-0000-0000-000000000000', null)
on conflict (user_id) do nothing;
```

The user must already exist in `auth.users` (the foreign key enforces this).

## Revoke

```sql
delete from public.seo_platform_admins
where user_id = '00000000-0000-0000-0000-000000000000';
```

## Verify

1. Confirm the row exists:

   ```sql
   select user_id, created_at, created_by from public.seo_platform_admins;
   ```

2. Have the operator sign in and load the app. The header shows an **Admin**
   entry (driven by `MeDto.is_platform_admin` from `GET /api/me`).
3. Confirm a *different* signed-in user does not see the entry and receives
   `403` from any `/api/admin/*` call.

## Boundaries to preserve

- Never authorize platform admin from the browser, from `email`, or from a
  project role. `AccessService.requirePlatformAdmin(user.sub)` is the single
  server-side gate.
- A registry lookup/storage failure must surface as `500`, never `403`, so an
  outage cannot look like an authorization decision.
- Keep the registry server-only: no self-service path, no policies, no grants
  to `anon`/`authenticated`.

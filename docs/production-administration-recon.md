# Production Administration Recon (P2)

Recon for the production-administration task: account identity, project
membership, platform administration, usage/metering and settings/navigation.
Each capability is classified EXISTS / PARTIAL / MISSING / OUT OF SCOPE and the
classification is grounded in file references so the decision is auditable.

This document is the Phase A recon and the Phase G record. See **Final State**
at the end.

## Scope boundary

Two hard rules shape everything below:

1. Reuse the existing account/project/membership/role model. Do not introduce a
   second authorization system.
2. Keep account-level concerns separate from project-level concerns, and keep
   platform administration separate from both.

The current repository has **one** membership model: `seo_project_members`
(viewer/editor/admin/owner). There is no account-membership table and no
platform-admin mechanism. That constrains what "account member administration"
and "platform administration" can mean without violating the rules.

---

## Account

| Capability | Classification | Evidence |
| --- | --- | --- |
| Account identity | EXISTS | `seo_accounts` (one row per owning user, `owner_user_id`), `seo_ensure_account` RPC; `apps/api/src/http/routes/account.ts`; `GET /api/account` |
| Account overview | EXISTS | `apps/api/src/http/routes/account.ts` (`/account`, `/account/overview`); `apps/web/src/views/Overview.tsx` |
| Account/project relationship | EXISTS | `seo_projects.account_id`; projects resolve under an account; creation via `seo_create_project` |
| Account API keys | EXISTS | `apps/api/src/http/routes/accountApiKeys.ts`; `apps/web/src/views/AccountApiKeys.tsx` (nav id `keys`) |
| Account AI / BYOK | EXISTS | `apps/api/src/http/routes/accountAi.ts`, `aiSettings.ts`; BYOK keys read from user-oriented env names per CLAUDE.md |
| Account integrations | EXISTS | `apps/api/src/http/routes/integrations.ts`, `projectGsc.ts`, `oauth.ts`; `apps/web/src/views/AccountIntegrations.tsx` |
| Account navigation/settings | EXISTS | `TOP_NAV` in `apps/web/src/App.tsx:75` (Overview, Projects, Integrations, API keys, Usage) |
| Account-level membership model | **OUT OF SCOPE** | No `seo_account_members`; accounts are 1:1 with the owner user. Introducing one would be a new authorization system (forbidden). |

Conclusion: the account surface is complete for a single-owner account. The
only gap the brief names at account level ("Members") is actually a
**project-membership** gap - see below.

## Project membership

| Capability | Classification | Evidence |
| --- | --- | --- |
| Membership table/model | EXISTS | `seo_project_members` (`project_id`, `user_id`, `role`), `supabase/migrations/20260101000002_projects_members.sql` |
| Roles owner/admin/editor/viewer | EXISTS | Role check constraints + `seo_has_role`; `supabase/migrations/20260101000006_rls.sql` |
| Membership authorization helpers | EXISTS | `seo_is_member`, `seo_has_role` (SQL); `AccessService.requireRole`/`requireAccount` (`apps/api/src/supabase.ts`) |
| Project member routes | **MISSING** | No member endpoints under `apps/api/src/http/routes/` (REST layer has none) |
| Invitation routes/models | **MISSING** | No `seo_invites` table or invite endpoints anywhere |
| Member management UI | **MISSING** | `rg` for the member RPCs in `apps/web/src` returns no callers |
| Member management RPCs | EXISTS | `seo_list_project_members`, `seo_add_project_member`, `seo_update_project_member_role`, `seo_remove_project_member` (`20260101000006_rls.sql:342-487`) - fully implemented, authorization + owner protection included, **zero callers** |

Conclusion: the capability exists in the database with server-side
authorization and owner protection, but nothing in the product exposes it. This
is a real, straightforward gap already covered by the existing architecture, so
Phase B **is implemented** (see below) - it wires the existing RPCs, adds no
new authorization model, and invents no invitation system (adding a member
requires the user to already have an account; there is no invitation
infrastructure to reuse).

## Platform administration

| Capability | Classification | Evidence |
| --- | --- | --- |
| `/admin` routes | EXISTS (Phase C) | `adminRouter` (`apps/api/src/http/routes/admin.ts`), mounted at `/api/admin` in `apps/api/src/app.ts` |
| Admin-only API routes | EXISTS (Phase C) | Router-level `container.access.requirePlatformAdmin(user.sub)` guard on every route |
| service-role/admin helpers | EXISTS | Service-role Supabase client is the API's normal client; `AccessService.isPlatformAdmin`/`requirePlatformAdmin` is the platform-admin identity |
| Platform-admin tables/claims/roles | EXISTS (Phase C) | `seo_platform_admins` registry (`supabase/migrations/20260101000032_platform_admins.sql`), keyed by user id, populated out of band |
| Internal/admin UI | EXISTS (Phase C) | `apps/web/src/views/admin/*`, top-level `/admin` area, nav gated on `me.is_platform_admin` |
| Audit/admin infrastructure | PARTIAL | `seo_activity`-style activity rows exist for account activity, but there is still no platform-wide mutation audit surface (this phase is read-only) |

Conclusion: the trusted mechanism is a server-only registry (`seo_platform_admins`)
keyed by the authenticated user id - never email, never a project role, never a
client claim. Phase C **is implemented** as a read-only operational surface:
overview, users, accounts, projects and cross-account usage. See **Phase C
decision** below for the mechanism and its rationale.

## Usage / metering

| Capability | Classification | Evidence |
| --- | --- | --- |
| Usage events/accounting | EXISTS | Existing `seo_usage_events`-backed metering (R5.10) |
| Account usage API | EXISTS | `apps/api/src/http/routes/usage.ts` (`/api/account/usage`) |
| Project usage API | EXISTS | `apps/api/src/http/routes/usage.ts` (`/api/projects/:projectId/usage`) |
| Usage contract | EXISTS | `UsageReportDto` in `@seo/contracts` (category/provider/operation/unit/quantity/eventCount) |
| Usage UI | EXISTS | `apps/web/src/views/Usage.tsx`, mounted at both account (`/usage`) and project (`/p/:id/usage`) scope; tests in `apps/web/src/views/Usage.test.tsx` |
| Provider-specific costs | PARTIAL | Report carries usage quantities; monetary cost is not modeled, so the UI shows usage rather than inventing a value (correct per the brief) |

Conclusion: Phase D is **review-only**. The desired structure (usage vs cost,
provider, period, account/project scope) is already served by the existing
contract. No new billing engine is added, per the brief.

## Settings / navigation

| Location | Classification | Evidence |
| --- | --- | --- |
| Account settings/nav | EXISTS | `TOP_NAV` (`App.tsx:75`) + account header nav |
| Project settings | EXISTS | `apps/web/src/views/ProjectSettings.tsx`; `PROJECT_NAV` (`App.tsx:83`, id `settings`) |
| Integrations | EXISTS | Account + project Integrations views |
| Usage | EXISTS | Account + project Usage |
| Where admin lives | EXISTS (Phase C) | Separate top-level `/admin` area (`AdminArea`), deliberately outside project navigation |

Conclusion: Phase E is **reconciled**. Member administration is a project-level
concern and lives in Project Settings. Platform administration is a separate
top-level area (`/admin`) and is not placed in project navigation.

---

## Phase C decision (platform administration)

The Phase A recon stopped here because platform admin needed a security
decision. That decision is now made explicitly:

- **Registry, not claims.** The operator identity is a row in a server-only
  `seo_platform_admins` table keyed by the authenticated Supabase **user id**.
  RLS is enabled with no policies, privileges are revoked from
  `anon`/`authenticated` and granted only to `service_role`. It is populated out
  of band (SQL / operator action); there is no self-service grant path. See
  `docs/platform-admin-bootstrap.md`.
- **One primitive.** `AccessService.isPlatformAdmin(userId)` /
  `requirePlatformAdmin(userId)` is the only gate. Every `/api/admin` route and
  the MCP surface must use it. Project `owner`/`admin` roles are explicitly not
  platform admins; the decision is never derived from the client or from email.
- **Defense in depth.** The admin read RPCs are `security definer`, re-check the
  actor with `seo_assert_platform_admin`, and are executable only by
  `service_role`.
- **Fail loud.** A registry lookup fault is a `500`, never a `403`, so a storage
  outage cannot masquerade as an authorization denial.

## Phase A/B implementation summary

Implemented (Phase B, project member administration):

- `apps/web/src/lib/members.ts` - typed wrappers over the four existing RPCs.
- `apps/web/src/components/members/MembersPanel.tsx` - member table, invite,
  role change and removal. Rendered only for owner/admin; the server RPCs
  remain the source of truth (`42501` for unauthorized callers).
- `apps/web/src/views/ProjectSettings.tsx` - mounts the panel.
- `apps/web/src/components/members/MembersPanel.test.tsx` - UI tests.
- `scripts/db-migrate-local.sh` - database smoke test proving the authorization
  boundaries (editor/viewer refused, admin cannot grant owner, owner protection,
  role change, removal) against a fresh local database.

Implemented (Phase C, platform administration - read-only):

- `supabase/migrations/20260101000032_platform_admins.sql` - the
  `seo_platform_admins` registry, `seo_is_platform_admin` /
  `seo_assert_platform_admin`, and six service-role-only read RPCs.
- `apps/api/src/supabase.ts` - `AccessService.isPlatformAdmin` /
  `requirePlatformAdmin` (the single gate).
- `apps/api/src/services/platformAdminService.ts` - read-only service mapping
  the RPCs to DTOs; `42501` -> `403`, any other RPC error -> `500`.
- `apps/api/src/http/routes/admin.ts` - `adminRouter` with the router-level gate
  and `/overview`, `/users`, `/accounts`, `/projects`, `/usage`.
- `packages/contracts/src/admin.ts` + `MeDto.is_platform_admin` - the admin DTOs
  and the flag the UI gates on.
- `apps/web/src/lib/admin.ts`, `apps/web/src/views/admin/*`, `AppHeader` admin
  entry, top-level `/admin` route - the operator UI (no secrets, read-only).
- Tests: `apps/api/src/http/routes/admin.test.ts`,
  `apps/api/src/services/platformAdminService.test.ts`,
  `apps/web/src/views/admin/AdminArea.test.tsx`,
  `apps/web/src/App.adminNav.test.tsx`, plus route-contract cases in
  `apps/web/src/lib/projectRoute.test.ts`.
- `scripts/db-migrate-local.sh` - smoke test proving a project owner is refused,
  a registered admin is allowed, and the registry/RPCs are server-only.
- `docs/platform-admin-bootstrap.md` - how an operator is provisioned.

## Final State

```text
Authentication              COMPLETE
Account administration      COMPLETE
Member administration       PARTIAL
Project administration      COMPLETE
Usage / metering            COMPLETE
Platform administration     COMPLETE (read-only operational surface)
Settings/navigation         COMPLETE
```

Notes:

- **Member administration is PARTIAL** only in the sense that it is
  project-scoped, matching the one membership model that exists. There is no
  account-level member model and none was invented. Invitations are limited to
  users that already have an account (no invitation infrastructure exists to
  reuse); building one is left out deliberately.
- **Platform administration is COMPLETE as a read-only surface.** Dashboard,
  users, accounts, projects and usage are served from existing data through a
  single server-side gate. There are deliberately no billing/subscription
  concepts, no destructive account/project controls and no self-service admin
  grant.
- No billing engine, no new project roles, no second authorization system, and
  no GSC changes were introduced.

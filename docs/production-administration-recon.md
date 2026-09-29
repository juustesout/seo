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
| `/admin` routes | **MISSING** | No admin router registered in the API |
| Admin-only API routes | **MISSING** | No admin middleware or admin route group |
| service-role/admin helpers | EXISTS (not platform-scoped) | Service-role Supabase client is the API's normal client; it is not a platform-admin identity |
| Platform-admin tables/claims/roles | **MISSING** | No platform-admin table, no `app_metadata` flag, no platform-admin claim |
| Internal/admin UI | **MISSING** | No admin view or route |
| Audit/admin infrastructure | PARTIAL | `seo_activity`-style activity rows exist for account activity, but there is no platform-wide audit/admin surface |

Conclusion: there is **no adequate existing platform-admin surface and no
trusted platform-admin mechanism**. Implementing one requires a security model
or product decision (how the operator identity is provisioned and verified),
which the brief says to stop and document rather than guess. See
**Phase C decision** below. Phase C is **not implemented**.

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
| Where admin would live | N/A | No admin surface exists; would be a separate top-level area, not project nav |

Conclusion: Phase E is **reconciled, no navigation change needed**. Member
administration is a project-level concern and lives in Project Settings.
Platform admin, if it is ever built, must be a separate top-level area and must
not be placed in project navigation.

---

## Phase C decision (platform administration: STOP)

The brief: if platform-admin authorization requires a new security model or a
product decision, stop after the recon and identify the decision instead of
guessing. That condition is met:

- No trusted platform-admin mechanism exists (no table, flag, claim or route).
- A correct implementation needs a decision on **how the platform-operator
  identity is provisioned and verified**, and that is a security decision, not
  an implementation detail. Candidate options (all require an explicit
  decision) include:
  1. A dedicated `seo_platform_admins` table keyed by user id, populated out of
     band via SQL (no UI path to grant it). Simplest and auditable.
  2. A Supabase `app_metadata.platform_admin` JWT claim checked server-side.
     Ties the grant to the auth provider's admin API.
- Whichever is chosen, the gate must be explicit and server-side, must not read
  project membership roles, and must have its own tests proving that a normal
  user and a project `admin` are both refused.

Per the brief, no platform-admin code is added until that decision is made.
This is a deliberate deferral, recorded here, not an oversight.

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

## Final State

```text
Authentication              COMPLETE
Account administration      COMPLETE
Member administration       PARTIAL
Project administration      COMPLETE
Usage / metering            COMPLETE
Platform administration     OUT OF SCOPE
Settings/navigation         COMPLETE
```

Notes:

- **Member administration is PARTIAL** only in the sense that it is
  project-scoped, matching the one membership model that exists. There is no
  account-level member model and none was invented. Invitations are limited to
  users that already have an account (no invitation infrastructure exists to
  reuse); building one is left out deliberately.
- **Platform administration is OUT OF SCOPE** pending the security/product
  decision documented above. It was not guessed.
- No billing engine, no new roles, no second authorization system, and no GSC
  changes were introduced.

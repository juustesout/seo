-- ============================================================================
-- Security hardening (audit P0).
--
-- Two issues fixed here, both verified against the live policy graph:
--
--   1. seo_projects (and the member roster) granted access on
--      `created_by = auth.uid()` independently of membership. Because a
--      project creator is inserted as `owner` by the
--      seo_projects_add_owner_membership trigger, created_by was a redundant
--      second ownership path that survived removal/demotion of the creator
--      (and could never be revoked). Membership is now the single source of
--      truth.
--
--   2. The SECURITY DEFINER helpers were created with the default PUBLIC
--      EXECUTE grant, so anon/authenticated could call them directly as RPCs
--      with a caller-supplied user id (membership / account enumeration) or,
--      for seo_ensure_account, create accounts. This revokes the PUBLIC/anon
--      grant. seo_is_member / seo_has_role / seo_account_id_for_user keep
--      EXECUTE for `authenticated` because RLS policy expressions are
--      evaluated with the invoking role's privileges (revoking from
--      authenticated would make every project-scoped read fail with
--      "permission denied for function"). seo_ensure_account is a write
--      helper reached only from SECURITY DEFINER triggers, so it is revoked
--      from authenticated entirely.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. seo_projects - membership only (creator backdoor removed)
-- ----------------------------------------------------------------------------

drop policy if exists seo_projects_select on public.seo_projects;
create policy seo_projects_select on public.seo_projects
  for select using (public.seo_is_member(id, auth.uid()));

drop policy if exists seo_projects_update on public.seo_projects;
create policy seo_projects_update on public.seo_projects
  for update using (public.seo_has_role(id, array['owner', 'admin']))
  with check (public.seo_has_role(id, array['owner', 'admin']));

drop policy if exists seo_projects_delete on public.seo_projects;
create policy seo_projects_delete on public.seo_projects
  for delete using (public.seo_has_role(id, array['owner']));

-- seo_projects_insert is intentionally unchanged: a user may only create a
-- project owned by themselves, and the AFTER INSERT trigger makes them its
-- owner member.

-- ----------------------------------------------------------------------------
-- 2. seo_project_members - drop the created_by read backdoor
-- ----------------------------------------------------------------------------

drop policy if exists seo_project_members_select on public.seo_project_members;
create policy seo_project_members_select on public.seo_project_members
  for select using (
    user_id = auth.uid()
    or public.seo_has_role(project_id, array['owner', 'admin'])
  );

-- ----------------------------------------------------------------------------
-- 3. Definer helpers - remove the default PUBLIC EXECUTE grant
-- ----------------------------------------------------------------------------

revoke execute on function public.seo_is_member(uuid, uuid) from public, anon;
revoke execute on function public.seo_has_role(uuid, text[]) from public, anon;
revoke execute on function public.seo_account_id_for_user(uuid) from public, anon;
grant execute on function public.seo_is_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.seo_has_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.seo_account_id_for_user(uuid) to authenticated, service_role;

revoke execute on function public.seo_ensure_account(uuid) from public, anon, authenticated;
grant execute on function public.seo_ensure_account(uuid) to service_role;

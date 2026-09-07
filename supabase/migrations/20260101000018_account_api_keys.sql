-- ============================================================================
-- SEO Platform - Account (master) API keys
--
-- Account API keys are the multi-project twin of project API keys. They live
-- in the same seo_api_keys table with project_id = NULL and belong to the user
-- who created them (created_by). A master key may address every project that
-- user is a member of, but never stronger than that membership: the REST v1
-- and MCP boundaries resolve the creator's per-request role in the target
-- project and AND it with the key's read/write scopes. Only a SHA-256 hash is
-- stored, exactly as with project keys, so management must not need the
-- plaintext twice.
-- ============================================================================

-- Account keys carry no project; project_id becomes nullable.
alter table public.seo_api_keys
  alter column project_id drop not null;

-- Project keys stay unique per (project, name). A plain unique index treats
-- NULL project_id rows as always-distinct, so account keys need their own
-- partial index: one name per owner.
drop index if exists seo_api_keys_project_name;
create unique index seo_api_keys_project_name
  on public.seo_api_keys (project_id, name)
  where project_id is not null;

create unique index seo_api_keys_account_name
  on public.seo_api_keys (created_by, name)
  where project_id is null;

-- RLS: project keys remain managed by project owners/admins (seo_has_role);
-- account keys are managed by their own creator. NULL project_id never reaches
-- seo_has_role (which only understands project rows), so an explicit owner
-- policy is required or account keys would be unmanageable via PostgREST.
drop policy if exists seo_api_keys_manage on public.seo_api_keys;
create policy seo_api_keys_manage on public.seo_api_keys
  for all to authenticated
  using (project_id is not null and public.seo_has_role(project_id, array['owner', 'admin']))
  with check (project_id is not null and public.seo_has_role(project_id, array['owner', 'admin']));

drop policy if exists seo_api_keys_account_manage on public.seo_api_keys;
create policy seo_api_keys_account_manage on public.seo_api_keys
  for all to authenticated
  using (project_id is null and created_by = auth.uid())
  with check (project_id is null and created_by = auth.uid());

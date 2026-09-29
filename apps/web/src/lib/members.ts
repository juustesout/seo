/**
 * Project member administration (P2, Phase B).
 *
 * Thin typed wrappers over the four member RPCs that already exist in the
 * database (`seo_list_project_members`, `seo_add_project_member`,
 * `seo_update_project_member_role`, `seo_remove_project_member`). Authorization
 * lives in the database functions - they raise `42501` for callers without the
 * required project role and enforce owner protection (a project must keep at
 * least one owner) - so this module only marshals arguments and surfaces the
 * server error verbatim. It deliberately does not re-implement any role rule:
 * the UI hiding an action is not authorization.
 */
import { supabase } from './supabase';

export type MemberRole = 'owner' | 'admin' | 'editor' | 'viewer';

export const MEMBER_ROLES: MemberRole[] = ['owner', 'admin', 'editor', 'viewer'];

export interface ProjectMember {
  user_id: string;
  email: string | null;
  role: MemberRole;
  created_at: string;
}

function client() {
  if (!supabase) throw new Error('Supabase not configured');
  return supabase;
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const { data, error } = await client().rpc('seo_list_project_members', { p_project: projectId });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectMember[];
}

export async function addProjectMember(
  projectId: string,
  email: string,
  role: MemberRole,
): Promise<string> {
  const { data, error } = await client().rpc('seo_add_project_member', {
    p_project: projectId,
    p_email: email,
    p_role: role,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? 'Member added';
}

export async function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: MemberRole,
): Promise<string> {
  const { data, error } = await client().rpc('seo_update_project_member_role', {
    p_project: projectId,
    p_user: userId,
    p_role: role,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? 'Role updated';
}

export async function removeProjectMember(projectId: string, userId: string): Promise<string> {
  const { data, error } = await client().rpc('seo_remove_project_member', {
    p_project: projectId,
    p_user: userId,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? 'Member removed';
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeKeyProject } from '../routes/v1.js';
import type { ApiKeyRecord } from '../../infra/apiKeys.js';
import { ApiError } from '../../apiErrors.js';
import type { AccessService } from '../../supabase.js';
import type { MemberRole } from '@seo/contracts';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

function projectKey(projectId: string): ApiKeyRecord {
  return {
    id: 'k1',
    project_id: projectId,
    name: 'project key',
    key_prefix: 'seo_live_abcdefghijkl',
    scopes: ['read', 'write'],
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
  };
}

function accountKey(createdBy: string | null): ApiKeyRecord {
  return {
    id: 'k2',
    project_id: null,
    name: 'master key',
    key_prefix: 'seo_live_abcdefghijkl',
    scopes: ['read', 'write'],
    created_by: createdBy,
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
  };
}

const ROLE_ORDER: Record<MemberRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** AccessService double resolving the creator's role in the target project. */
function access(roleFor: (userId: string, projectId: string) => MemberRole | null): Pick<AccessService, 'requireRole'> {
  return {
    requireRole: async (userId: string, projectId: string, minRole: MemberRole) => {
      const role = roleFor(userId, projectId);
      if (!role) throw ApiError.forbidden('You do not have access to this project');
      if (ROLE_ORDER[role] < ROLE_ORDER[minRole]) {
        throw ApiError.forbidden(`This action requires the ${minRole} role`);
      }
      return { project_id: projectId, role };
    },
  };
}

const alwaysMember = access((_u, pid) => (pid === PROJECT_A ? 'admin' : null));
const viewerOnly = access(() => 'viewer');
const editorOnly = access(() => 'editor');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('v1 api key -> project authorization', () => {
  it('a project key only ever reaches its own project', async () => {
    const d = alwaysMember;
    await expect(authorizeKeyProject(d, projectKey(PROJECT_A), PROJECT_A, 'editor')).resolves.toBe(PROJECT_A);
    await expect(authorizeKeyProject(d, projectKey(PROJECT_A), PROJECT_B, 'viewer')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('an account key reaches a project the owner is a member of', async () => {
    const d = alwaysMember;
    await expect(authorizeKeyProject(d, accountKey('user-1'), PROJECT_A, 'editor')).resolves.toBe(PROJECT_A);
  });

  it('an account key is refused for a project the owner does not belong to', async () => {
    const d = alwaysMember;
    await expect(authorizeKeyProject(d, accountKey('user-1'), PROJECT_B, 'viewer')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('a viewer membership cannot satisfy an editor requirement even with a write-scoped key', async () => {
    await expect(authorizeKeyProject(viewerOnly, accountKey('user-1'), PROJECT_A, 'editor')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(authorizeKeyProject(viewerOnly, accountKey('user-1'), PROJECT_A, 'viewer')).resolves.toBe(PROJECT_A);
  });

  it('an editor membership satisfies viewer and editor requirements', async () => {
    await expect(authorizeKeyProject(editorOnly, accountKey('user-1'), PROJECT_A, 'viewer')).resolves.toBe(PROJECT_A);
    await expect(authorizeKeyProject(editorOnly, accountKey('user-1'), PROJECT_A, 'editor')).resolves.toBe(PROJECT_A);
  });

  it('refuses an account key that lost its owner identity', async () => {
    await expect(authorizeKeyProject(alwaysMember, accountKey(null), PROJECT_A, 'viewer')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('refuses reads and writes when the owner has no membership in the project', async () => {
    const strict = access(() => null);
    await expect(authorizeKeyProject(strict, accountKey('user-1'), PROJECT_A, 'viewer')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(authorizeKeyProject(strict, accountKey('user-1'), PROJECT_A, 'editor')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

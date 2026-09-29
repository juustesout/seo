/**
 * MembersPanel tests (P2, Phase B).
 *
 * The member library is mocked so the component's real `useAsync` runs while
 * the RPC boundary is observable. Covers: viewer/editor get no usable member
 * administration (and no request is made), owner/admin see members and roles,
 * invite, role change, removal (with confirmation), owner protection mirroring
 * the server rule, the admin grant ceiling, and honest surfacing of a server
 * authorization error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectMember } from '../../lib/members';
import { MembersPanel } from './MembersPanel';

const { membersMock } = vi.hoisted(() => ({
  membersMock: {
    listProjectMembers: vi.fn(),
    addProjectMember: vi.fn(),
    updateProjectMemberRole: vi.fn(),
    removeProjectMember: vi.fn(),
  },
}));

vi.mock('../../lib/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/members')>();
  return {
    ...actual,
    listProjectMembers: (...args: unknown[]) => membersMock.listProjectMembers(...args),
    addProjectMember: (...args: unknown[]) => membersMock.addProjectMember(...args),
    updateProjectMemberRole: (...args: unknown[]) => membersMock.updateProjectMemberRole(...args),
    removeProjectMember: (...args: unknown[]) => membersMock.removeProjectMember(...args),
  };
});

const OWNER: ProjectMember = {
  user_id: 'u-owner',
  email: 'owner@example.com',
  role: 'owner',
  created_at: '2026-01-01T00:00:00Z',
};
const EDITOR: ProjectMember = {
  user_id: 'u-editor',
  email: 'editor@example.com',
  role: 'editor',
  created_at: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  membersMock.listProjectMembers.mockReset();
  membersMock.addProjectMember.mockReset();
  membersMock.updateProjectMemberRole.mockReset();
  membersMock.removeProjectMember.mockReset();
  membersMock.listProjectMembers.mockResolvedValue([OWNER, EDITOR]);
  membersMock.addProjectMember.mockResolvedValue('Member added');
  membersMock.updateProjectMemberRole.mockResolvedValue('Role updated');
  membersMock.removeProjectMember.mockResolvedValue('Member removed');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MembersPanel', () => {
  it('does not expose member administration to an editor or viewer', () => {
    render(<MembersPanel projectId="p-1" role="editor" />);
    expect(screen.queryByText('Members')).toBeNull();
    render(<MembersPanel projectId="p-1" role="viewer" />);
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(membersMock.listProjectMembers).not.toHaveBeenCalled();
  });

  it('lists current members and their roles for an admin', async () => {
    render(<MembersPanel projectId="p-1" role="admin" />);
    expect(await screen.findByText('owner@example.com')).toBeTruthy();
    expect(screen.getByText('editor@example.com')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getAllByText('editor').length).toBeGreaterThan(0);
    expect(membersMock.listProjectMembers).toHaveBeenCalledWith('p-1');
  });

  it('lets an owner add an existing user by email', async () => {
    render(<MembersPanel projectId="p-1" role="owner" />);
    await screen.findByText('owner@example.com');

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(membersMock.addProjectMember).toHaveBeenCalledWith('p-1', 'new@example.com', 'admin'),
    );
    expect(await screen.findByText('Member added.')).toBeTruthy();
  });

  it('caps an admin invite at editor/viewer (no owner or admin grant)', async () => {
    render(<MembersPanel projectId="p-1" role="admin" />);
    await screen.findByText('owner@example.com');

    const roles = Array.from((screen.getByLabelText('Role') as HTMLSelectElement).options).map((o) => o.value);
    expect(roles).toEqual(['editor', 'viewer']);
    expect(screen.queryByLabelText('Role for owner@example.com')).toBeNull();
  });

  it('changes a member role as an owner', async () => {
    render(<MembersPanel projectId="p-1" role="owner" />);
    await screen.findByText('editor@example.com');

    fireEvent.change(screen.getByLabelText('Role for editor@example.com'), { target: { value: 'viewer' } });

    await waitFor(() =>
      expect(membersMock.updateProjectMemberRole).toHaveBeenCalledWith('p-1', 'u-editor', 'viewer'),
    );
  });

  it('removes a member only after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MembersPanel projectId="p-1" role="owner" />);
    await screen.findByText('editor@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Remove editor@example.com' }));
    expect(membersMock.removeProjectMember).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove editor@example.com' }));
    await waitFor(() => expect(membersMock.removeProjectMember).toHaveBeenCalledWith('p-1', 'u-editor'));
  });

  it('protects the last owner from removal and demotion', async () => {
    membersMock.listProjectMembers.mockResolvedValue([OWNER]);
    render(<MembersPanel projectId="p-1" role="owner" />);
    await screen.findByText('owner@example.com');

    expect((screen.getByRole('button', { name: 'Remove owner@example.com' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Role for owner@example.com') as HTMLSelectElement).disabled).toBe(true);
  });

  it('surfaces a server authorization error instead of faking data', async () => {
    membersMock.listProjectMembers.mockRejectedValue(
      new Error('Only project owners and admins can view the member list'),
    );
    render(<MembersPanel projectId="p-1" role="admin" />);
    expect(await screen.findByText('Only project owners and admins can view the member list')).toBeTruthy();
  });
});

/**
 * AdminArea tests (P3, Phase C).
 *
 * The admin API library is mocked so the real `useAsync` runs while the request
 * boundary stays observable. Verifies: a non-administrator sees only the
 * not-authorized notice and no admin request is made; an administrator sees the
 * section nav and each section renders real server data; and a server
 * authorization failure is surfaced honestly rather than swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminArea } from './AdminArea';

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    adminOverview: vi.fn(),
    adminUsers: vi.fn(),
    adminAccounts: vi.fn(),
    adminProjects: vi.fn(),
    adminUsage: vi.fn(),
  },
}));

vi.mock('../../lib/admin', () => ({
  adminOverview: (...args: unknown[]) => adminMock.adminOverview(...args),
  adminUsers: (...args: unknown[]) => adminMock.adminUsers(...args),
  adminAccounts: (...args: unknown[]) => adminMock.adminAccounts(...args),
  adminProjects: (...args: unknown[]) => adminMock.adminProjects(...args),
  adminUsage: (...args: unknown[]) => adminMock.adminUsage(...args),
}));

beforeEach(() => {
  adminMock.adminOverview.mockReset();
  adminMock.adminUsers.mockReset();
  adminMock.adminAccounts.mockReset();
  adminMock.adminProjects.mockReset();
  adminMock.adminUsage.mockReset();
  adminMock.adminOverview.mockResolvedValue({
    users: 3,
    accounts: 2,
    projects: 4,
    jobs: 10,
    active_jobs: 1,
    failed_jobs: 2,
    usage_events_this_period: 42,
    usage_period_start: '2026-09-01T00:00:00Z',
    recent_jobs: [],
  });
  adminMock.adminUsers.mockResolvedValue([
    { user_id: 'u-1', email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', account_id: 'acc-1', project_count: 2 },
  ]);
  adminMock.adminAccounts.mockResolvedValue([
    { account_id: 'acc-1', name: 'Acme', owner_user_id: 'u-1', owner_email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', project_count: 2, member_count: 3 },
  ]);
  adminMock.adminProjects.mockResolvedValue([
    { project_id: 'p-1', name: 'Site', account_id: 'acc-1', created_by: 'u-1', created_at: '2026-01-01T00:00:00Z', member_count: 2 },
  ]);
  adminMock.adminUsage.mockResolvedValue({ totals: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminArea authorization gate', () => {
  it('shows a notice and fetches nothing for a non-administrator', () => {
    render(<AdminArea view="overview" isAdmin={false} onNavigate={() => {}} />);
    expect(screen.getByText('Platform administrator access required')).toBeTruthy();
    expect(adminMock.adminOverview).not.toHaveBeenCalled();
    expect(adminMock.adminUsers).not.toHaveBeenCalled();
    expect(adminMock.adminUsage).not.toHaveBeenCalled();
  });
});

describe('AdminArea sections', () => {
  it('renders overview metrics for an administrator', async () => {
    render(<AdminArea view="overview" isAdmin onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
    expect(screen.getByText('Active jobs')).toBeTruthy();
    expect(adminMock.adminOverview).toHaveBeenCalledTimes(1);
  });

  it('renders the users table from server data', async () => {
    render(<AdminArea view="users" isAdmin onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('a@example.com')).toBeTruthy());
    expect(adminMock.adminUsers).toHaveBeenCalledTimes(1);
    expect(adminMock.adminAccounts).not.toHaveBeenCalled();
  });

  it('renders accounts and projects from server data', async () => {
    const { rerender } = render(<AdminArea view="accounts" isAdmin onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    rerender(<AdminArea view="projects" isAdmin onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('Site')).toBeTruthy());
    expect(adminMock.adminProjects).toHaveBeenCalledTimes(1);
  });

  it('navigates sections through the supplied callback', () => {
    const onNavigate = vi.fn();
    render(<AdminArea view="overview" isAdmin onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(onNavigate).toHaveBeenCalledWith('projects');
  });

  it('surfaces a server authorization failure honestly', async () => {
    adminMock.adminUsage.mockRejectedValue(new Error('Request failed (403)'));
    render(<AdminArea view="usage" isAdmin onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('Request failed (403)')).toBeTruthy());
  });
});

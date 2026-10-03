/**
 * Mobile project navigation tests (P6a).
 *
 * Below the `md` breakpoint the desktop project sidebar is hidden, so the same
 * project views must remain reachable through a header menu button that opens an
 * overlay drawer. These tests cover the trigger, the drawer contents/close
 * behaviour, and that switching projects keeps the current view.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppHeader, MobileProjectNav } from './App';

vi.mock('./lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

const projects = [
  { id: 'p1', name: 'Alpha', role: 'owner', website_url: null, connected_count: 0, integration_count: 0, last_sync_at: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'p2', name: 'Beta', role: 'owner', website_url: null, connected_count: 0, integration_count: 0, last_sync_at: null, created_at: '2026-01-01T00:00:00Z' },
];

const headerBase = {
  meEmail: 'op@example.com',
  onSignOut: () => {},
  active: null,
  onArea: () => {},
  projects: [],
  currentProjectId: null,
  onOpenProject: () => {},
};

describe('project navigation menu button', () => {
  it('is shown only when a menu handler is provided', () => {
    const { rerender } = render(<AppHeader {...headerBase} isAdmin={false} adminActive={false} onAdmin={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open project navigation' })).toBeNull();

    const onOpenProjectMenu = vi.fn();
    rerender(
      <AppHeader
        {...headerBase}
        onOpenProjectMenu={onOpenProjectMenu}
        isAdmin={false}
        adminActive={false}
        onAdmin={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open project navigation' }));
    expect(onOpenProjectMenu).toHaveBeenCalledTimes(1);
  });

  it('switching projects preserves the current view', () => {
    const onOpenProject = vi.fn();
    render(
      <AppHeader
        {...headerBase}
        projects={projects}
        currentProjectId="p1"
        currentView="analytics"
        onOpenProject={onOpenProject}
        isAdmin={false}
        adminActive={false}
        onAdmin={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } });
    expect(onOpenProject).toHaveBeenCalledWith('p2', 'analytics');
  });
});

describe('mobile project navigation drawer', () => {
  it('renders nothing while closed and the project views while open', () => {
    const { rerender } = render(
      <MobileProjectNav projectId="p1" view="dashboard" open={false} onNavigate={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(
      <MobileProjectNav projectId="p1" view="dashboard" open onNavigate={() => {}} onClose={() => {}} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Project navigation' });
    expect(dialog.textContent).toContain('Dashboard');
    expect(dialog.textContent).toContain('Settings');
  });

  it('navigates and closes when an entry is chosen', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<MobileProjectNav projectId="p1" view="dashboard" open onNavigate={onNavigate} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('p1', 'settings');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<MobileProjectNav projectId="p1" view="dashboard" open onNavigate={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

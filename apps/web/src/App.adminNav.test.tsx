/**
 * Admin navigation visibility tests (P3, Phase C).
 *
 * The header must expose the platform-administration entry only for a
 * server-declared administrator. This is a convenience gate: the API authorizes
 * every admin request independently of the UI.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppHeader } from './App';

vi.mock('./lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

const base = {
  meEmail: 'op@example.com',
  onSignOut: () => {},
  active: null,
  onArea: () => {},
  projects: [],
  currentProjectId: null,
  onOpenProject: () => {},
};

describe('platform admin navigation entry', () => {
  it('is hidden for a normal user', () => {
    render(<AppHeader {...base} isAdmin={false} adminActive={false} onAdmin={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Platform administration' })).toBeNull();
  });

  it('is shown for an administrator and opens the admin area', () => {
    const onAdmin = vi.fn();
    render(<AppHeader {...base} isAdmin adminActive={false} onAdmin={onAdmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Platform administration' }));
    expect(onAdmin).toHaveBeenCalledTimes(1);
  });
});

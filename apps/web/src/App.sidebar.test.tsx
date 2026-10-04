/**
 * Project sidebar tests (P8 UI modernisation).
 *
 * The sidebar must communicate product structure through navigation groups and
 * be collapsible to an icon-only mode whose state persists across reloads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectSidebar } from './App';

vi.mock('./lib/supabase', () => ({
  supabase: null,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

const COLLAPSE_KEY = 'seo.sidebar.collapsed';

function renderSidebar() {
  return render(
    <ProjectSidebar
      projectId="p1"
      view="dashboard"
      onNavigate={() => {}}
      projectName="Alpha"
      websiteUrl="https://alpha.example.com"
      connectedCount={1}
      integrationCount={2}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectSidebar', () => {
  it('renders the categorized navigation groups', () => {
    renderSidebar();
    for (const group of ['Overview', 'Google', 'Writing', 'Publishing', 'User']) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: 'Search Console' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('collapses to an icon-only mode and persists the choice', () => {
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1');
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('starts collapsed when the persisted choice is set', () => {
    window.localStorage.setItem(COLLAPSE_KEY, '1');
    renderSidebar();
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });
});

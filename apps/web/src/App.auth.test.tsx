/**
 * AuthScreen Google login test (P1).
 *
 * Verifies the application boundary around the Supabase client: the auth
 * screen renders a Google action, it invokes the existing Supabase OAuth
 * method with provider `google` and the running app origin as the redirect,
 * an initiation failure is surfaced in the existing error slot, and the
 * pre-existing email/password flow is unchanged. The Supabase client is
 * mocked; no real Google credentials are involved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const { authMock, supabaseMock } = vi.hoisted(() => {
  const authMock = {
    signInWithOAuth: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  };
  return { authMock, supabaseMock: { auth: authMock } };
});

vi.mock('./lib/supabase', () => ({
  supabase: supabaseMock,
  configured: true,
  currentUser: vi.fn(async () => null),
  sessionToken: vi.fn(async () => null),
}));

async function renderAuthScreen() {
  render(<App />);
  return screen.findByRole('button', { name: 'Continue with Google' });
}

describe('AuthScreen Google login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.signInWithOAuth.mockResolvedValue({ error: null });
    authMock.signInWithPassword.mockResolvedValue({ error: null });
  });

  it('renders the Google action alongside the existing auth methods', async () => {
    await renderAuthScreen();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account instead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a magic link instead' })).toBeTruthy();
  });

  it('invokes Supabase OAuth with provider google and the app origin as redirect', async () => {
    await renderAuthScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(authMock.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(authMock.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  });

  it('surfaces an OAuth initiation failure in the existing error slot', async () => {
    authMock.signInWithOAuth.mockResolvedValue({ error: { message: 'OAuth provider unavailable' } });
    await renderAuthScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText('OAuth provider unavailable')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves email/password login behavior unchanged', async () => {
    await renderAuthScreen();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(authMock.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(authMock.signInWithPassword).toHaveBeenCalledWith({ email: 'user@example.com', password: 'secret' });
  });
});

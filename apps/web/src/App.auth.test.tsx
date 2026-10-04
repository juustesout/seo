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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const { authMock, supabaseMock } = vi.hoisted(() => {
  const authMock = {
    signInWithOAuth: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resend: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
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

describe('AuthScreen password reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.resetPasswordForEmail.mockResolvedValue({ error: null });
    authMock.updateUser.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    window.history.replaceState({}, '', window.location.pathname);
  });

  it('requests a reset email for the entered address', async () => {
    await renderAuthScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => expect(authMock.resetPasswordForEmail).toHaveBeenCalledTimes(1));
    expect(authMock.resetPasswordForEmail).toHaveBeenCalledWith('user@example.com', {
      redirectTo: window.location.origin,
    });
    expect(await screen.findByText(/password reset link is on its way/i)).toBeTruthy();
  });

  it('shows the new-password screen for a recovery link and applies the password', async () => {
    window.history.replaceState({}, '', `${window.location.pathname}#access_token=tok&type=recovery`);
    render(<App />);

    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'new-secret-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-secret-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });

    await waitFor(() => expect(authMock.updateUser).toHaveBeenCalledWith({ password: 'new-secret-1' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Set new password' })).toBeNull());
  });
});

describe('AuthScreen one-time code type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.verifyOtp.mockResolvedValue({ error: null });
    authMock.resend.mockResolvedValue({ error: null });
    authMock.signUp.mockResolvedValue({ error: null, data: { session: null } });
    authMock.signInWithOtp.mockResolvedValue({ error: null });
  });

  it('verifies a signup confirmation code as type signup', async () => {
    await renderAuthScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Create account instead' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    fireEvent.change(await screen.findByLabelText('One-time code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() =>
      expect(authMock.verifyOtp).toHaveBeenCalledWith({ email: 'new@example.com', token: '123456', type: 'signup' }),
    );
  });

  it('verifies a magic-link code as type email', async () => {
    await renderAuthScreen();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a magic link instead' }));

    fireEvent.change(await screen.findByLabelText('One-time code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() =>
      expect(authMock.verifyOtp).toHaveBeenCalledWith({ email: 'user@example.com', token: '654321', type: 'email' }),
    );
  });

  it('re-sends a signup confirmation for a signup code', async () => {
    await renderAuthScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Create account instead' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByLabelText('One-time code');
    fireEvent.click(screen.getByRole('button', { name: 'Re-send code' }));

    await waitFor(() => expect(authMock.resend).toHaveBeenCalledWith({ type: 'signup', email: 'new@example.com' }));
  });
});

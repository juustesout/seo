/**
 * Public legal pages must render for anonymous visitors and be linked from a
 * shared footer. These tests assert the documents exist, carry their headings,
 * and expose the footer links - not the legal wording itself.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LegalFooter, LegalPage } from './Legal';

describe('legal pages', () => {
  it('renders the privacy policy', () => {
    render(<LegalPage view="privacy" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy Policy');
    expect(screen.getByText(/General Data Protection Regulation/)).toBeTruthy();
    expect(screen.getByText(/right to access, rectify, erase/)).toBeTruthy();
  });

  it('renders the terms of service', () => {
    render(<LegalPage view="terms" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Terms of Service');
    expect(screen.getByText(/Acceptable use/)).toBeTruthy();
  });

  it('renders the cookie policy and states only necessary storage is used', () => {
    render(<LegalPage view="cookies" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cookie Policy');
    expect(screen.getByText(/No advertising or tracking cookies/)).toBeTruthy();
    expect(screen.getByText(/sb-\*-auth-token/)).toBeTruthy();
  });
});

describe('legal footer', () => {
  it('links the three legal documents', () => {
    render(<LegalFooter />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/privacy');
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/cookies');
  });

  it('is present on the legal pages it links to', () => {
    render(<LegalPage view="privacy" />);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain('/cookies');
  });
});

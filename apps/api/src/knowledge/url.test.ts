import { describe, expect, it } from 'vitest';
import { validateExternalUrl } from './url.js';
import { KnowledgeIngestError } from './errors.js';

function expectInvalid(raw: string): void {
  expect(() => validateExternalUrl(raw)).toThrow(KnowledgeIngestError);
  try {
    validateExternalUrl(raw);
  } catch (err) {
    expect((err as KnowledgeIngestError).code).toBe('knowledge_invalid_url');
  }
}

describe('validateExternalUrl (SSRF guard)', () => {
  it('accepts public http(s) URLs and returns the parsed URL', () => {
    expect(validateExternalUrl('https://example.com/a?b=1').toString()).toBe('https://example.com/a?b=1');
    expect(validateExternalUrl('http://example.com').hostname).toBe('example.com');
    expect(validateExternalUrl('  https://example.com/x  ').hostname).toBe('example.com');
  });

  it('rejects non-strings, empty values and over-long URLs', () => {
    expectInvalid(undefined as unknown as string);
    expectInvalid('');
    expectInvalid('   ');
    expectInvalid(`https://example.com/${'a'.repeat(3000)}`);
  });

  it('rejects unsupported or dangerous schemes', () => {
    for (const raw of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi', 'javascript:alert(1)', 'gopher://example.com']) {
      expectInvalid(raw);
    }
  });

  it('rejects URLs carrying userinfo credentials', () => {
    expectInvalid('https://user:pass@example.com/x');
    expectInvalid('https://user@example.com/x');
  });

  it('rejects loopback and local hostnames', () => {
    for (const raw of [
      'http://localhost/x',
      'http://foo.localhost/x',
      'http://printer.local/x',
      'http://db.internal/x',
      'http://x.home.arpa/x',
      'http://intranet/',
    ]) {
      expectInvalid(raw);
    }
  });

  it('rejects private, loopback, link-local, CGNAT, multicast and reserved IPv4', () => {
    for (const raw of [
      'http://127.0.0.1/x',
      'http://127.1.2.3/x',
      'http://10.0.0.5/x',
      'http://172.16.9.9/x',
      'http://172.31.255.1/x',
      'http://192.168.1.1/x',
      'http://169.254.1.1/x',
      'http://0.0.0.0/x',
      'http://100.64.0.1/x',
      'http://224.0.0.1/x',
      'http://240.0.0.1/x',
      'http://192.0.2.1/x',
      'http://198.18.0.1/x',
      'http://203.0.113.1/x',
    ]) {
      expectInvalid(raw);
    }
  });

  it('rejects loopback, unique-local, link-local and multicast IPv6', () => {
    for (const raw of [
      'http://[::1]/x',
      'http://[::]/x',
      'http://[fe80::1]/x',
      'http://[fd00::1]/x',
      'http://[fc00::1]/x',
      'http://[ff02::1]/x',
      'http://[2001:db8::1]/x',
      'http://[::ffff:127.0.0.1]/x',
    ]) {
      expectInvalid(raw);
    }
  });

  it('blocks obfuscated loopback literals the URL parser normalizes to dotted-quad', () => {
    expectInvalid('http://2130706433/x');
    expectInvalid('http://0x7f.0.0.1/x');
  });

  it('allows public IPv4 and IPv6 literals', () => {
    expect(validateExternalUrl('http://8.8.8.8/x').hostname).toBe('8.8.8.8');
    expect(validateExternalUrl('http://[2606:4700:4700::1111]/x').hostname).toBe('[2606:4700:4700::1111]');
  });
});

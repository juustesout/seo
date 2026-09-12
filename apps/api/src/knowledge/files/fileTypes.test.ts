import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_FILE_ACCEPT,
  fileExtension,
  hasValidSignature,
  resolveFileType,
  sanitizeFilename,
} from './fileTypes.js';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('sanitizeFilename', () => {
  it('keeps a normal filename', () => {
    expect(sanitizeFilename('Quarterly Report.pdf')).toBe('Quarterly Report.pdf');
  });

  it('strips directory components (path traversal)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\system32\\evil.txt')).toBe('evil.txt');
    expect(sanitizeFilename('/tmp/../secret.md')).toBe('secret.md');
  });

  it('removes control characters and NUL bytes', () => {
    expect(sanitizeFilename('bad\u0000name\n.txt')).toBe('badname.txt');
  });

  it('replaces unsafe characters and falls back when empty', () => {
    expect(sanitizeFilename('weird<name>.pdf')).toBe('weird_name_.pdf');
    expect(sanitizeFilename('....')).toBe('file');
  });
});

describe('resolveFileType', () => {
  it('resolves the supported extensions', () => {
    expect(resolveFileType('a.txt', 'text/plain')).toMatchObject({ ok: true, spec: { format: 'txt' } });
    expect(resolveFileType('a.md', 'text/markdown')).toMatchObject({ ok: true, spec: { format: 'md' } });
    expect(resolveFileType('a.markdown', 'text/plain')).toMatchObject({ ok: true, spec: { format: 'md' } });
    expect(resolveFileType('a.pdf', 'application/pdf')).toMatchObject({ ok: true, spec: { format: 'pdf' } });
    expect(
      resolveFileType('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toMatchObject({ ok: true, spec: { format: 'docx' } });
  });

  it('rejects unknown extensions', () => {
    expect(resolveFileType('a.exe', 'application/octet-stream')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(resolveFileType('a', 'text/plain')).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('rejects a mismatched declared MIME for a known extension', () => {
    expect(resolveFileType('a.pdf', 'image/png')).toEqual({ ok: false, reason: 'mime_mismatch' });
  });

  it('tolerates generic MIME types', () => {
    expect(resolveFileType('a.pdf', 'application/octet-stream')).toMatchObject({ ok: true });
    expect(resolveFileType('a.pdf', '')).toMatchObject({ ok: true });
  });

  it('exposes an accept list for the UI', () => {
    expect(KNOWLEDGE_FILE_ACCEPT).toContain('.pdf');
    expect(KNOWLEDGE_FILE_ACCEPT).toContain('.docx');
    expect(fileExtension('Report.PDF')).toBe('pdf');
  });
});

describe('hasValidSignature', () => {
  it('accepts a PDF magic header only', () => {
    expect(hasValidSignature('pdf', new TextEncoder().encode('%PDF-1.7 body'))).toBe(true);
    expect(hasValidSignature('pdf', new TextEncoder().encode('not a pdf'))).toBe(false);
  });

  it('accepts a DOCX ZIP signature', () => {
    expect(hasValidSignature('docx', bytes(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe(true);
    expect(hasValidSignature('docx', bytes(0x50, 0x4b, 0x03, 0x08))).toBe(true);
    expect(hasValidSignature('docx', new TextEncoder().encode('plain'))).toBe(false);
  });

  it('rejects binary-looking text files', () => {
    expect(hasValidSignature('txt', new TextEncoder().encode('hello world'))).toBe(true);
    expect(hasValidSignature('md', bytes(0x68, 0x69, 0x00, 0x00))).toBe(false);
  });
});

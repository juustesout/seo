/**
 * Uploaded knowledge file validation (KB4).
 *
 * One small, deliberate allow-list: TXT, Markdown, PDF and DOCX. The extension
 * picks the format; the declared MIME must agree (empty / application/octet-stream
 * are tolerated because browsers and proxies are inconsistent); and a cheap
 * magic/signature check runs on the bytes so a renamed executable is rejected
 * before any parser touches it. Everything here is pure and free of I/O.
 */

import type { KnowledgeFileFormat } from '@seo/contracts';

export interface KnowledgeFileTypeSpec {
  format: KnowledgeFileFormat;
  label: string;
  extensions: readonly string[];
  mimes: readonly string[];
}

export const KNOWLEDGE_FILE_TYPES: readonly KnowledgeFileTypeSpec[] = [
  { format: 'txt', label: 'Text', extensions: ['txt'], mimes: ['text/plain'] },
  {
    format: 'md',
    label: 'Markdown',
    extensions: ['md', 'markdown'],
    mimes: ['text/markdown', 'text/x-markdown', 'text/plain'],
  },
  { format: 'pdf', label: 'PDF', extensions: ['pdf'], mimes: ['application/pdf'] },
  {
    format: 'docx',
    label: 'Word document',
    extensions: ['docx'],
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
];

/** MIME types that are too generic to reject on their own (extension + magic still apply). */
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** File extensions the UI may accept (kept in sync with KNOWLEDGE_FILE_TYPES). */
export const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_FILE_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)).join(',');

export function fileExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : '';
}

/**
 * Strip everything that could become a path or a header injection: directory
 * components, control characters, NUL bytes. The result is display-only - the
 * server never derives a storage path from it - but it must still be safe to
 * echo back to the UI and store on the row.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '');
  return cleaned.slice(0, 180) || 'file';
}

export type FileTypeResult =
  | { ok: true; spec: KnowledgeFileTypeSpec }
  | { ok: false; reason: 'unsupported_type' | 'mime_mismatch' };

/**
 * Resolve the format for an upload from its filename + declared MIME. The
 * extension is authoritative; an explicitly non-generic MIME must be one the
 * format declares, so `image/png` renamed to `.pdf` is refused here.
 */
export function resolveFileType(filename: string, contentType: string): FileTypeResult {
  const ext = fileExtension(filename);
  const spec = KNOWLEDGE_FILE_TYPES.find((t) => t.extensions.includes(ext));
  if (!spec) return { ok: false, reason: 'unsupported_type' };
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!GENERIC_MIMES.has(mime) && !spec.mimes.includes(mime)) return { ok: false, reason: 'mime_mismatch' };
  return { ok: true, spec };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}

function hasNulByte(bytes: Uint8Array, limit = 4096): boolean {
  const end = Math.min(bytes.length, limit);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Cheap content signature check keyed by format. PDF must start with `%PDF-`;
 * DOCX is a ZIP container (PK signature); text formats must not look binary.
 * Returns false when the bytes clearly do not match the claimed format.
 */
export function hasValidSignature(format: KnowledgeFileFormat, bytes: Uint8Array): boolean {
  if (format === 'pdf') return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (format === 'docx') {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
      (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
    );
  }
  return !hasNulByte(bytes);
}

/** Human label for broad UI display (falls back to the extension). */
export function fileTypeLabel(format: KnowledgeFileFormat | null, filename: string): string {
  const spec = KNOWLEDGE_FILE_TYPES.find((t) => t.format === format);
  return spec?.label ?? (fileExtension(filename).toUpperCase() || 'File');
}

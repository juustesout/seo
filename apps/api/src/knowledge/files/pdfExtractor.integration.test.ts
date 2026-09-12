import { describe, expect, it } from 'vitest';
import { createPdfFileExtractor } from './extractors.js';

/**
 * Real (unmocked) PDF extraction smoke test. The rest of the file extractor
 * tests mock the parser to stay fast and deterministic; this one builds a
 * minimal valid PDF in memory and proves unpdf actually reads its text layer in
 * the server runtime (no fixture binary committed, no network).
 */
function buildPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('PDF extractor (real parser)', () => {
  it('extracts the text layer from a generated PDF', async () => {
    const bytes = buildPdf('Hello KB4');
    const result = await createPdfFileExtractor().extract({
      filename: 'hello.pdf',
      contentType: 'application/pdf',
      size: bytes.length,
      bytes,
    });
    expect(result.contentText).toContain('Hello KB4');
    expect(result.title).toBe('hello');
  });
});

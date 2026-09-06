/**
 * Byte-level image detection (Content Studio Phase F).
 *
 * Uploaded files are never trusted by their content-type header or extension:
 * the first bytes are sniffed and the pixel dimensions are read directly from
 * the container/header. Only the Phase F formats are recognized - anything else
 * (SVG included) is reported as unsupported rather than guessed at.
 */

export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SniffedImage {
  mime: SniffedImageMime;
  /** Canonical storage extension for the detected format. */
  ext: 'png' | 'jpg' | 'webp';
  width: number | null;
  height: number | null;
}

const MAX_EDGE = 20000;

function matches(buf: Buffer, sig: readonly number[], offset: number): boolean {
  if (offset + sig.length > buf.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function sane(w: number, h: number): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= MAX_EDGE && h <= MAX_EDGE;
}

function png(buf: Buffer): SniffedImage | null {
  if (buf.length < 24) return null;
  // IHDR chunk: length(4) 'IHDR'(4) width(4) height(4)
  if (!matches(buf, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!sane(width, height)) return null;
  return { mime: 'image/png', ext: 'png', width, height };
}

function jpeg(buf: Buffer): SniffedImage | null {
  // Walk the segment table until an SOF marker yields dimensions (bounded, so a
  // truncated/garbage file cannot spin forever).
  let offset = 2;
  let guard = 0;
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < buf.length && guard++ < 1024) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = buf.readUInt16BE(offset + 2);
    if (SOF.has(marker) && segLen >= 7) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (!sane(width, height)) return null;
      return { mime: 'image/jpeg', ext: 'jpg', width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

function webp(buf: Buffer): SniffedImage | null {
  if (buf.length < 30) return null;
  if (!matches(buf, [0x52, 0x49, 0x46, 0x46], 0)) return null;
  if (!matches(buf, [0x57, 0x45, 0x42, 0x50], 8)) return null;
  const fourcc = buf.toString('latin1', 12, 16);
  const chunkSize = buf.readUInt32LE(16);
  const payload = 20;
  if (payload + chunkSize > buf.length) return null;

  if (fourcc === 'VP8X') {
    if (chunkSize < 10) return null;
    const width = buf.readUIntLE(payload + 4, 3) + 1;
    const height = buf.readUIntLE(payload + 7, 3) + 1;
    if (!sane(width, height)) return null;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (fourcc === 'VP8L') {
    if (chunkSize < 5) return null;
    if (buf[payload] !== 0x2f) return null;
    const bits = buf.readUInt32LE(payload + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    if (!sane(width, height)) return null;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (fourcc === 'VP8 ') {
    if (chunkSize < 10) return null;
    // lossy key frame: frame tag(3) + 9d 01 2a start code then 14-bit dims
    if (!matches(buf, [0x9d, 0x01, 0x2a], payload + 3)) return null;
    const width = buf.readUInt16LE(payload + 6) & 0x3fff;
    const height = buf.readUInt16LE(payload + 8) & 0x3fff;
    if (!sane(width, height)) return null;
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  return null;
}

/**
 * Sniff a buffer and report the detected Phase F image format + dimensions.
 * Returns null when the bytes are not a supported image (or are truncated).
 */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (!buf || buf.length < 12) return null;
  if (matches(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) return png(buf);
  if (matches(buf, [0xff, 0xd8, 0xff], 0)) return jpeg(buf);
  if (matches(buf, [0x52, 0x49, 0x46, 0x46], 0)) return webp(buf);
  return null;
}

import { describe, expect, it } from 'vitest';
import { sniffImage } from './imageBytes.js';

describe('sniffImage (phase F image detection)', () => {
  it('detects a png from its signature and reads IHDR dimensions', () => {
    const buf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(800, 16);
    buf.writeUInt32BE(600, 20);
    expect(sniffImage(buf)).toEqual({ mime: 'image/png', ext: 'png', width: 800, height: 600 });
  });

  it('detects a jpeg by walking markers to the SOF segment', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x01, 0xe0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    expect(sniffImage(buf)).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 480, height: 600 });
  });

  it('detects lossy webp and reads its 14-bit dimensions', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(36, 4);
    buf.write('WEBP', 8, 'latin1');
    buf.write('VP8 ', 12, 'latin1');
    buf.writeUInt32LE(10, 16);
    buf[20] = 0x00;
    buf[21] = 0x00;
    buf[22] = 0x00;
    buf[23] = 0x9d;
    buf[24] = 0x01;
    buf[25] = 0x2a;
    buf.writeUInt16LE(1023, 26);
    buf.writeUInt16LE(511, 28);
    expect(sniffImage(buf)).toEqual({ mime: 'image/webp', ext: 'webp', width: 1023, height: 511 });
  });

  it('rejects svg and unknown content regardless of how plausible it looks', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a...........'))).toBeNull();
    expect(sniffImage(Buffer.from('#!/bin/sh\necho pwned'))).toBeNull();
  });

  it('rejects empty, truncated and dimension-lying files', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();

    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(99999, 16);
    png.writeUInt32BE(600, 20);
    expect(sniffImage(png)).toBeNull();
  });
});

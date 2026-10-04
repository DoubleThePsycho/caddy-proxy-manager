/**
 * White-label uploads (ee/white-label/images.ts): only PNG, JPEG, WebP and
 * ICO, recognised by content; SVG, markup and polyglots refused; metadata
 * removed; size and dimension limits.
 */
import { describe, expect, it } from 'vitest';
import { checkDeclaredFile, containsEmbeddedMarkup, crc32, detectImageType, ImageRejectedError, sanitizeImage, type ImageRules } from '@/ee/white-label/images';
import { ASSET_LIMITS, MAX_ASSET_BYTES } from '@/ee/white-label/types';
import { jpegComment, jpegExif, makeIco, makeJpeg, makePng, makeWebp, pngChunk, textChunk } from '../helpers/images';
import { crc32 as nodeCrc32 } from 'node:zlib';

const logo: ImageRules = { ...ASSET_LIMITS.logoLight, maxBytes: MAX_ASSET_BYTES };
const favicon: ImageRules = { ...ASSET_LIMITS.favicon, maxBytes: MAX_ASSET_BYTES };

function refused(data: Buffer, rules: ImageRules = logo): string {
  try {
    sanitizeImage(data, rules);
  } catch (error) {
    expect(error).toBeInstanceOf(ImageRejectedError);
    expect((error as ImageRejectedError).status).toBe(400);
    return (error as Error).message;
  }
  throw new Error('the image was accepted');
}

describe('detection', () => {
  it('recognises the four accepted types by their magic bytes', () => {
    expect(detectImageType(makePng())).toBe('image/png');
    expect(detectImageType(makeJpeg())).toBe('image/jpeg');
    expect(detectImageType(makeWebp())).toBe('image/webp');
    expect(detectImageType(makeIco([{ png: makePng(16, 16), size: 16 }]))).toBe('image/x-icon');
    expect(detectImageType(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBeNull();
  });

  it('computes the PNG CRC like zlib', () => {
    const data = Buffer.from('IHDR and some bytes');
    expect(crc32(data)).toBe(nodeCrc32(data) >>> 0);
  });
});

describe('accepted images', () => {
  it('keeps a PNG and reports its size', () => {
    const image = sanitizeImage(makePng(40, 20), logo);
    expect(image).toMatchObject({ type: 'image/png', width: 40, height: 20 });
    expect(detectImageType(image.data)).toBe('image/png');
  });

  it('removes text and private chunks from a PNG but keeps colour information', () => {
    const gamma = pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]));
    const input = makePng(4, 4, [textChunk('Software', 'Some editor 1.0'), gamma, pngChunk('prVt', Buffer.from('private'))]);
    const image = sanitizeImage(input, logo);
    const text = image.data.toString('latin1');
    expect(text).not.toContain('tEXt');
    expect(text).not.toContain('Some editor');
    expect(text).not.toContain('prVt');
    expect(text).toContain('gAMA');
    expect(image.data.length).toBeLessThan(input.length);
  });

  it('removes EXIF and comments from a JPEG', () => {
    const image = sanitizeImage(makeJpeg(30, 10, [jpegExif('GPS 45.0N 9.0E'), jpegComment('made by a camera')]), logo);
    expect(image).toMatchObject({ type: 'image/jpeg', width: 30, height: 10 });
    const text = image.data.toString('latin1');
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('made by a camera');
    expect(text).toContain('JFIF');
    expect(image.data.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('removes EXIF from a WebP and clears its flag', () => {
    const image = sanitizeImage(makeWebp(9, 3, 'Camera serial 1234'), logo);
    expect(image).toMatchObject({ type: 'image/webp', width: 9, height: 3 });
    expect(image.data.toString('latin1')).not.toContain('Camera serial');
    expect(image.data.readUInt32LE(4) + 8).toBe(image.data.length);
    const vp8x = image.data.indexOf('VP8X');
    expect(image.data[vp8x + 8] & 0x08).toBe(0);
  });

  it('accepts an ICO favicon holding PNGs and reports the largest image', () => {
    const ico = makeIco([{ png: makePng(16, 16), size: 16 }, { png: makePng(32, 32, [textChunk('Comment', 'hi')]), size: 32 }]);
    const image = sanitizeImage(ico, favicon);
    expect(image).toMatchObject({ type: 'image/x-icon', width: 32, height: 32 });
    expect(image.data.toString('latin1')).not.toContain('tEXt');
    // The rewritten directory points at the rewritten images.
    expect(sanitizeImage(image.data, favicon).data).toEqual(image.data);
  });
});

describe('refused files', () => {
  it.each([
    ['plain SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['SVG with an XML prolog', '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['SVG after white space and a BOM', '\ufeff  \n<svg onload="alert(1)"/>'],
    ['HTML', '<!doctype html><html><body>hi</body></html>'],
  ])('refuses %s', (_name, text) => {
    expect(refused(Buffer.from(text, 'utf8'))).toMatch(/SVG and other markup files are not accepted/);
  });

  it('refuses types that are not accepted, and ICO as a logo', () => {
    expect(refused(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))).toMatch(/Only PNG, JPEG or WebP images are accepted/);
    expect(refused(makeIco([{ png: makePng(16, 16), size: 16 }]))).toMatch(/ICO images are not accepted here/);
  });

  it('refuses a PNG with HTML appended after its end (polyglot)', () => {
    const polyglot = Buffer.concat([makePng(), Buffer.from('<html><script>alert(document.cookie)</script></html>')]);
    expect(refused(polyglot)).toMatch(/embedded HTML or script/);
    // Appended bytes without markup (a ZIP, say) are refused for being there at all.
    const zipped = Buffer.concat([makePng(), Buffer.from('PK\x03\x04 archive bytes', 'latin1')]);
    expect(refused(zipped)).toMatch(/data after its end/);
  });

  it('refuses a PNG with script in a text chunk (polyglot)', () => {
    expect(refused(makePng(2, 2, [textChunk('Comment', '<script>alert(1)</script>')]))).toMatch(/embedded HTML or script/);
  });

  it('refuses a JPEG with HTML in a comment or after its end', () => {
    expect(refused(makeJpeg(4, 4, [jpegComment('<iframe src=//example.com>')]))).toMatch(/embedded HTML or script/);
    expect(refused(Buffer.concat([makeJpeg(), Buffer.from('trailing bytes')]))).toMatch(/data after its end/);
  });

  it('refuses a WebP whose RIFF size does not match the file', () => {
    expect(refused(Buffer.concat([makeWebp(), Buffer.from('extra')]))).toMatch(/after its end or is truncated/);
  });

  it('refuses an ICO with data outside its images', () => {
    const ico = Buffer.concat([makeIco([{ png: makePng(16, 16), size: 16 }]), Buffer.from('hidden')]);
    expect(refused(ico, favicon)).toMatch(/after its end/);
  });

  it('refuses damaged and truncated images', () => {
    const png = makePng();
    const corrupt = Buffer.from(png);
    corrupt[png.length - 20] ^= 0xff;
    expect(refused(corrupt)).toMatch(/damaged/);
    expect(refused(png.subarray(0, png.length - 12))).toMatch(/truncated/);
    expect(refused(makeJpeg().subarray(0, 40))).toMatch(/truncated/);
  });

  it('refuses unknown critical PNG chunks', () => {
    expect(refused(makePng(2, 2, [pngChunk('ZZZZ', Buffer.from('x'))]))).toMatch(/unsupported ZZZZ chunk/);
  });

  it('refuses files that are too large or have too many pixels', () => {
    expect(refused(Buffer.concat([makePng(), Buffer.alloc(MAX_ASSET_BYTES)]))).toMatch(/larger than 512 KB/);
    expect(refused(makePng(4096, 1))).toMatch(/4096×1 pixels; at most 2048×2048/);
    expect(refused(makePng(1024, 1024), favicon)).toMatch(/at most 512×512/);
    expect(refused(Buffer.alloc(0))).toBe('The file is empty');
  });
});

describe('declared name and type', () => {
  it('refuses SVG names and types and names that contradict the content', () => {
    expect(() => checkDeclaredFile('image/png', 'logo.svg', null)).toThrow('SVG files are not accepted');
    expect(() => checkDeclaredFile('image/png', 'logo.png', 'image/svg+xml')).toThrow(/SVG and other markup/);
    expect(() => checkDeclaredFile('image/png', 'logo.gif', 'image/png')).toThrow('The file name ends in .gif but the file is a PNG image');
    expect(() => checkDeclaredFile('image/jpeg', 'photo.JPG', 'image/jpeg')).not.toThrow();
    expect(() => checkDeclaredFile('image/x-icon', 'favicon.ico', 'image/vnd.microsoft.icon')).not.toThrow();
    expect(() => checkDeclaredFile('image/png', null, 'application/octet-stream')).not.toThrow();
  });
});

describe('markup scan', () => {
  it('finds markup case-insensitively and ignores ordinary bytes', () => {
    expect(containsEmbeddedMarkup(Buffer.from('xx<ScRiPt>'))).toBe(true);
    expect(containsEmbeddedMarkup(Buffer.from('a javascript:alert(1)'))).toBe(true);
    expect(containsEmbeddedMarkup(Buffer.from('<svg/onload=x>'))).toBe(true);
    expect(containsEmbeddedMarkup(Buffer.from('a < b and svg files'))).toBe(false);
    expect(containsEmbeddedMarkup(makePng(64, 64))).toBe(false);
  });
});

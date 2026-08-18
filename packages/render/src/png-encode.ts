/** PNG file signature (`89 50 4E 47 0D 0A 1A 0A`). */
export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(4 + 4 + data.length + 4);
  writeUint32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeUint32(out, 8 + data.length, crc32(crcInput));
  return out;
}

/** Store-only zlib so we do not take a deflate dependency in `@babylonslate/render`. */
function zlibStore(data: Uint8Array): Uint8Array {
  const max = 65535;
  const blockCount = Math.max(1, Math.ceil(data.length / max));
  let total = 2 + 4;
  for (let i = 0; i < blockCount; i += 1) {
    const start = i * max;
    const len = Math.min(max, data.length - start);
    total += 5 + len;
  }
  const out = new Uint8Array(total);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (let i = 0; i < blockCount; i += 1) {
    const start = i * max;
    const slice = data.subarray(start, start + max);
    const last = i === blockCount - 1 ? 1 : 0;
    out[offset] = last;
    out[offset + 1] = slice.length & 0xff;
    out[offset + 2] = (slice.length >>> 8) & 0xff;
    const nlen = (~slice.length) & 0xffff;
    out[offset + 3] = nlen & 0xff;
    out[offset + 4] = (nlen >>> 8) & 0xff;
    out.set(slice, offset + 5);
    offset += 5 + slice.length;
  }
  writeUint32(out, offset, adler32(data));
  return out;
}

/** Encode unpremultiplied RGBA8 into a PNG (filter 0, store-only IDAT). */
export function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (1 + rowBytes);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), dest + 1);
  }
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStore(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

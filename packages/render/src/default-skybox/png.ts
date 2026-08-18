/** Uncompressed PNG encoder for default cubemap faces (numeric buffers only). */

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
  const crc = crc32(concat([typeBytes, data]));
  return concat([u32be(data.byteLength), typeBytes, data, u32be(crc)]);
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  const max = 65535;
  for (let offset = 0; offset < data.byteLength; offset += max) {
    const slice = data.subarray(offset, Math.min(offset + max, data.byteLength));
    const last = offset + slice.byteLength >= data.byteLength ? 1 : 0;
    const len = slice.byteLength;
    const nlen = ~len & 0xffff;
    blocks.push(
      Uint8Array.of(
        last,
        len & 0xff,
        (len >>> 8) & 0xff,
        nlen & 0xff,
        (nlen >>> 8) & 0xff,
      ),
      slice,
    );
  }
  blocks.push(u32be(adler32(data)));
  return concat(blocks);
}

/** Filter-0 RGBA PNG. Used so missing cubemap faces can join CreateFromImages. */
export function encodePngRgba(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const ihdr = concat([
    u32be(width),
    u32be(height),
    Uint8Array.of(8, 6, 0, 0, 0),
  ]);
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStore(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

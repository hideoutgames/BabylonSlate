let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

/**
 * The ZIP / PNG CRC-32 of a byte stream fed in pieces: start from 0, pass
 * each piece with the previous result, and the last result is the checksum.
 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const lookup = crcTable();
  let crc = ~previous >>> 0;
  for (let index = 0; index < bytes.length; index++) {
    crc = lookup[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

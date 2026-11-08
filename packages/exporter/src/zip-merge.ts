/**
 * Reads a zip's central directory and writes a new zip from entries of
 * existing ones, copying each entry's compressed bytes unchanged. Native game
 * packages reuse Electron's runtime this way instead of inflating and
 * deflating ~300 MB on every export. Zip64 archives are refused; runtimes
 * and games stay well under its 4 GiB and 65,535-entry limits.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** General purpose flag bit 3: sizes and CRC follow the data instead of the local header. */
const DATA_DESCRIPTOR_FLAG = 0x8;
/** General purpose flag bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x800;

/** One central directory entry; the bytes stay in the archive they came from. */
export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** "Version made by": its high byte is the host system (3 is Unix, where `externalAttributes >>> 16` is the file mode). */
  madeBy: number;
  externalAttributes: number;
  localOffset: number;
}

/** An entry of `source` written under `name`. */
export interface ZipCopy {
  name: string;
  source: Uint8Array;
  entry: ZipEntry;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function invalid(detail: string): Error {
  return new Error(`Invalid zip archive: ${detail}`);
}

/** The archive's entries in central directory order. */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const data = view(zip);
  let eocd = -1;
  // The end record is 22 bytes plus a comment of at most 65,535.
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (data.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw invalid("no end of central directory.");
  const count = data.getUint16(eocd + 10, true);
  const directoryOffset = data.getUint32(eocd + 16, true);
  if (count === MAX_ENTRIES || directoryOffset === MAX_U32) throw invalid("Zip64 archives are not supported.");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || data.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw invalid("damaged central directory.");
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const entry: ZipEntry = {
      madeBy: data.getUint16(offset + 4, true),
      flags: data.getUint16(offset + 8, true),
      method: data.getUint16(offset + 10, true),
      time: data.getUint16(offset + 12, true),
      date: data.getUint16(offset + 14, true),
      crc: data.getUint32(offset + 16, true),
      compressedSize: data.getUint32(offset + 20, true),
      size: data.getUint32(offset + 24, true),
      externalAttributes: data.getUint32(offset + 38, true),
      localOffset: data.getUint32(offset + 42, true),
      name: decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength)),
    };
    if (entry.compressedSize === MAX_U32 || entry.size === MAX_U32 || entry.localOffset === MAX_U32) {
      throw invalid("Zip64 archives are not supported.");
    }
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The entry's stored (compressed) bytes. */
function storedData(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const data = view(zip);
  const offset = entry.localOffset;
  if (offset + 30 > zip.length || data.getUint32(offset, true) !== LOCAL_SIGNATURE) throw invalid(`damaged entry ${entry.name}.`);
  const start = offset + 30 + data.getUint16(offset + 26, true) + data.getUint16(offset + 28, true);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw invalid(`truncated entry ${entry.name}.`);
  return zip.subarray(start, end);
}

/**
 * A zip holding each copy in order. Data, CRC, compression and attributes
 * (Unix modes included) come from the source entry; only the name changes.
 */
export function writeZip(copies: readonly ZipCopy[]): Uint8Array {
  if (copies.length >= MAX_ENTRIES) throw new Error("A package holds at most 65,534 files.");
  const encoder = new TextEncoder();
  const prepared = copies.map((copy) => ({ ...copy, nameBytes: encoder.encode(copy.name), data: storedData(copy.source, copy.entry) }));
  const localSize = prepared.reduce((total, copy) => total + 30 + copy.nameBytes.length + copy.data.length, 0);
  const centralSize = prepared.reduce((total, copy) => total + 46 + copy.nameBytes.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_U32) throw new Error("A package cannot exceed 4 GiB.");
  const out = new Uint8Array(total);
  const data = view(out);
  const offsets: number[] = [];
  let offset = 0;
  for (const copy of prepared) {
    // Sizes go in the local header, so a trailing data descriptor is no longer needed.
    const flags = (copy.entry.flags & ~DATA_DESCRIPTOR_FLAG) | UTF8_FLAG;
    offsets.push(offset);
    data.setUint32(offset, LOCAL_SIGNATURE, true);
    data.setUint16(offset + 4, 20, true);
    data.setUint16(offset + 6, flags, true);
    data.setUint16(offset + 8, copy.entry.method, true);
    data.setUint16(offset + 10, copy.entry.time, true);
    data.setUint16(offset + 12, copy.entry.date, true);
    data.setUint32(offset + 14, copy.entry.crc, true);
    data.setUint32(offset + 18, copy.entry.compressedSize, true);
    data.setUint32(offset + 22, copy.entry.size, true);
    data.setUint16(offset + 26, copy.nameBytes.length, true);
    data.setUint16(offset + 28, 0, true);
    out.set(copy.nameBytes, offset + 30);
    out.set(copy.data, offset + 30 + copy.nameBytes.length);
    offset += 30 + copy.nameBytes.length + copy.data.length;
  }
  const directoryOffset = offset;
  prepared.forEach((copy, index) => {
    const flags = (copy.entry.flags & ~DATA_DESCRIPTOR_FLAG) | UTF8_FLAG;
    data.setUint32(offset, CENTRAL_SIGNATURE, true);
    data.setUint16(offset + 4, copy.entry.madeBy, true);
    data.setUint16(offset + 6, 20, true);
    data.setUint16(offset + 8, flags, true);
    data.setUint16(offset + 10, copy.entry.method, true);
    data.setUint16(offset + 12, copy.entry.time, true);
    data.setUint16(offset + 14, copy.entry.date, true);
    data.setUint32(offset + 16, copy.entry.crc, true);
    data.setUint32(offset + 20, copy.entry.compressedSize, true);
    data.setUint32(offset + 24, copy.entry.size, true);
    data.setUint16(offset + 28, copy.nameBytes.length, true);
    data.setUint32(offset + 38, copy.entry.externalAttributes, true);
    data.setUint32(offset + 42, offsets[index]!, true);
    out.set(copy.nameBytes, offset + 46);
    offset += 46 + copy.nameBytes.length;
  });
  data.setUint32(offset, EOCD_SIGNATURE, true);
  data.setUint16(offset + 8, prepared.length, true);
  data.setUint16(offset + 10, prepared.length, true);
  data.setUint32(offset + 12, offset - directoryOffset, true);
  data.setUint32(offset + 16, directoryOffset, true);
  return out;
}

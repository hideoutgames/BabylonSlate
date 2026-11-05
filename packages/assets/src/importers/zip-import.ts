import { Inflate } from "fflate";
import { contentEntryNameError } from "../registry-paths";
import type { ImportFileBytes } from "./obj-import-batch";
import { extensionOf } from "./util";

/** Entries (files and folders) a ZIP may list for the Content Browser to import it. */
export const ZIP_IMPORT_MAX_ENTRIES = 10_000;
/** Bytes the files a ZIP import extracts may expand to, together. */
export const ZIP_IMPORT_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

/** Why a ZIP entry was left out of the import. */
export type ZipSkipReason =
  | "unsupported"
  | "metadata"
  | "nested-zip"
  | "unsafe-path"
  | "encrypted"
  | "compression"
  | "damaged";

export interface SkippedZipEntry {
  /** The entry's path as the ZIP records it. */
  path: string;
  reason: ZipSkipReason;
}

export interface ExpandImportZipOptions {
  /** Whether a file of this name can be imported; other files are skipped. */
  isImportable: (fileName: string) => boolean;
  signal?: AbortSignal;
  /** Share of the archive expanded so far, 0-1. */
  onProgress?: (fraction: number) => void;
  maxEntries?: number;
  maxExpandedBytes?: number;
}

export interface ExpandedImportZip {
  /** Files to import, with paths relative to the ZIP's own folder (`Chair/chair.gltf`). */
  files: ImportFileBytes[];
  skipped: SkippedZipEntry[];
}

export function isZipFileName(fileName: string): boolean {
  return extensionOf(fileName) === "zip";
}

/** The folder a ZIP imports into: its file name without `.zip`, as a valid Content Browser name. */
export function zipImportFolderName(zipName: string): string {
  const stem = (zipName.split(/[\\/]/).pop() ?? zipName).replace(/\.zip$/i, "");
  const name = Array.from(stem, (character) =>
    /[\\/:*?"<>|]/.test(character) || character.charCodeAt(0) < 32 ? "_" : character,
  ).join("").trim().replace(/\.+$/, "");
  return contentEntryNameError(name) ? "Imported" : name;
}

const MIB = 1024 * 1024;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
/** Compressed bytes inflated between checks for the time slice and cancel; deflate expands at most ~1032×. */
const INFLATE_SLICE_BYTES = 64 * 1024;
/** Main-thread time one stretch of unzipping may take before it yields. */
const SLICE_MS = 12;

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** A read outside the archive or a missing signature: not a ZIP, or damaged where it was read. */
class ZipFormatError extends Error {
  constructor() {
    super("Not a ZIP archive, or the archive is damaged.");
  }
}

/** An entry whose data does not inflate to the size the archive records. */
class DamagedEntryError extends Error {}

class ZipReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private check(offset: number, length: number): void {
    if (offset < 0 || offset + length > this.bytes.byteLength) throw new ZipFormatError();
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }

  u64(offset: number): number {
    return this.u32(offset) + this.u32(offset + 4) * 2 ** 32;
  }

  slice(offset: number, length: number): Uint8Array {
    this.check(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

function decodeEntryName(raw: Uint8Array, flags: number): string {
  // Bit 11 marks UTF-8; many tools write UTF-8 without it, and the rest is code page 437.
  if (flags & 0x800) return new TextDecoder().decode(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return String.fromCharCode(...raw);
  }
}

/** Offset of the end-of-central-directory record, which closes every ZIP (after a comment of up to 64 KiB), or -1. */
function findEndOfCentralDirectory(zip: ZipReader): number {
  const length = zip.bytes.byteLength;
  for (let offset = length - 22; offset >= Math.max(0, length - 22 - 0xffff); offset -= 1) {
    if (zip.u32(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/** Whether `bytes` end like a ZIP archive, so a wrong pick can be refused by name before it is read. */
export function isZipArchive(bytes: Uint8Array): boolean {
  return findEndOfCentralDirectory(new ZipReader(bytes)) >= 0;
}

function readCentralDirectory(zip: ZipReader, maxEntries: number): CentralEntry[] {
  const end = findEndOfCentralDirectory(zip);
  if (end < 0) throw new ZipFormatError();
  let count = zip.u16(end + 10);
  let offset = zip.u32(end + 16);
  if ((count === 0xffff || offset === 0xffffffff) && end >= 20 && zip.u32(end - 20) === ZIP64_END_LOCATOR) {
    const zip64End = zip.u64(end - 12);
    if (zip.u32(zip64End) !== ZIP64_END) throw new ZipFormatError();
    count = zip.u64(zip64End + 32);
    offset = zip.u64(zip64End + 48);
  }
  if (count > maxEntries) {
    throw new Error(`It holds more than ${maxEntries.toLocaleString("en-US")} files and folders. Split it into smaller ZIPs.`);
  }
  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.u32(offset) !== CENTRAL_HEADER) throw new ZipFormatError();
    const flags = zip.u16(offset + 8);
    const method = zip.u16(offset + 10);
    let compressedSize = zip.u32(offset + 20);
    let size = zip.u32(offset + 24);
    const nameLength = zip.u16(offset + 28);
    const extraLength = zip.u16(offset + 30);
    const commentLength = zip.u16(offset + 32);
    let localOffset = zip.u32(offset + 42);
    const nameStart = offset + 46;
    const name = decodeEntryName(zip.slice(nameStart, nameLength), flags);
    // ZIP64 extra field: the 64-bit values of the fields saturated at 0xffffffff, in this order.
    const extraEnd = nameStart + nameLength + extraLength;
    for (let field = nameStart + nameLength; field + 4 <= extraEnd;) {
      const id = zip.u16(field);
      const fieldEnd = field + 4 + zip.u16(field + 2);
      let value = field + 4;
      if (id === 0x0001) {
        if (size === 0xffffffff && value + 8 <= fieldEnd) { size = zip.u64(value); value += 8; }
        if (compressedSize === 0xffffffff && value + 8 <= fieldEnd) { compressedSize = zip.u64(value); value += 8; }
        if (localOffset === 0xffffffff && value + 8 <= fieldEnd) localOffset = zip.u64(value);
      }
      field = fieldEnd;
    }
    entries.push({ name, flags, method, compressedSize, size, localOffset });
    offset = extraEnd + commentLength;
  }
  return entries;
}

/** The entry's compressed bytes, after its local header. */
function entryData(zip: ZipReader, entry: CentralEntry): Uint8Array {
  if (zip.u32(entry.localOffset) !== LOCAL_HEADER) throw new ZipFormatError();
  const start = entry.localOffset + 30 + zip.u16(entry.localOffset + 26) + zip.u16(entry.localOffset + 28);
  return zip.slice(start, entry.compressedSize);
}

type Classified =
  | { kind: "folder" }
  | { kind: "skip"; reason: ZipSkipReason; segments?: string[] }
  | { kind: "extract"; segments: string[] };

/** Backslashes are separators; `.` and empty segments drop; an absolute path or `..` is unsafe. */
function classifyEntry(entry: CentralEntry, isImportable: (fileName: string) => boolean): Classified {
  const path = entry.name.replace(/\\/g, "/");
  if (path.endsWith("/")) return { kind: "folder" };
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return { kind: "skip", reason: "unsafe-path" };
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) return { kind: "folder" };
  if (segments.includes("..")) return { kind: "skip", reason: "unsafe-path" };
  if (segments[0] === "__MACOSX" || segments.some((segment) => segment.startsWith("."))) {
    return { kind: "skip", reason: "metadata" };
  }
  if (segments.slice(0, -1).some((segment) => contentEntryNameError(segment))) {
    return { kind: "skip", reason: "unsafe-path" };
  }
  const fileName = segments[segments.length - 1]!;
  if (isZipFileName(fileName)) return { kind: "skip", reason: "nested-zip", segments };
  if (!isImportable(fileName)) return { kind: "skip", reason: "unsupported", segments };
  if (entry.flags & 0x1) return { kind: "skip", reason: "encrypted", segments };
  if (entry.method !== 0 && entry.method !== 8) return { kind: "skip", reason: "compression", segments };
  return { kind: "extract", segments };
}

/** Yields to the event loop once a stretch of work has run `SLICE_MS`, checking for cancel. */
function timeSlicer(signal: AbortSignal | undefined, onYield: () => void): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    signal?.throwIfAborted();
    if (performance.now() - sliceStart < SLICE_MS) return;
    onYield();
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    sliceStart = performance.now();
  };
}

async function expandEntry(
  data: Uint8Array,
  entry: CentralEntry,
  slice: () => Promise<void>,
  onBytes: (count: number) => void,
): Promise<Uint8Array> {
  if (entry.method === 0) {
    if (data.byteLength !== entry.size) throw new DamagedEntryError();
    await slice();
    onBytes(data.byteLength);
    return data.slice();
  }
  const out = new Uint8Array(entry.size);
  let written = 0;
  let ended = data.byteLength === 0 && entry.size === 0;
  // The declared size bounds memory: an entry that inflates past it is damaged or hostile.
  const inflate = new Inflate((chunk, final) => {
    if (written + chunk.byteLength > out.byteLength) throw new DamagedEntryError();
    out.set(chunk, written);
    written += chunk.byteLength;
    if (final) ended = true;
  });
  for (let start = 0; start < data.byteLength; start += INFLATE_SLICE_BYTES) {
    await slice();
    const end = Math.min(data.byteLength, start + INFLATE_SLICE_BYTES);
    try {
      inflate.push(data.subarray(start, end), end === data.byteLength);
    } catch {
      throw new DamagedEntryError();
    }
    onBytes(end - start);
  }
  if (!ended || written !== out.byteLength) throw new DamagedEntryError();
  return out;
}

/**
 * Reads a ZIP for the Content Browser to import into a folder of its own,
 * keeping the folders inside it. It reads the central directory, then
 * inflates the importable files a slice at a time, yielding to the event
 * loop so a large archive does not freeze the editor, and stops at once
 * when `signal` aborts.
 *
 * Left out and listed in `skipped`: files no importer reads, ZIPs inside the
 * ZIP (not opened), macOS metadata (`__MACOSX/`) and dot-files, entries with
 * an absolute path, a `..` segment or a folder name the Content Browser
 * cannot use, encrypted entries, entries compressed with anything but Stored
 * or Deflate, and damaged ones. Folder entries are not listed.
 *
 * When every remaining file sits in one top-level folder, that folder is
 * dropped, as a picked project folder's is, so `Props.zip` holding
 * `Props/…` does not import as `Props/Props/…`.
 *
 * Throws, importing nothing, when the archive is not a ZIP, lists more than
 * `maxEntries` entries, or its importable files would expand past
 * `maxExpandedBytes`.
 */
export async function expandImportZip(
  bytes: Uint8Array,
  options: ExpandImportZipOptions,
): Promise<ExpandedImportZip> {
  const { signal, onProgress, isImportable } = options;
  const maxEntries = options.maxEntries ?? ZIP_IMPORT_MAX_ENTRIES;
  const maxExpandedBytes = options.maxExpandedBytes ?? ZIP_IMPORT_MAX_EXPANDED_BYTES;
  signal?.throwIfAborted();
  const zip = new ZipReader(bytes);
  const entries = readCentralDirectory(zip, maxEntries);
  const skipped: SkippedZipEntry[] = [];
  const extract: Array<{ entry: CentralEntry; segments: string[] }> = [];
  /** Every file but metadata and unsafe paths, which decide whether one folder wraps the rest. */
  const contentPaths: string[][] = [];
  for (const entry of entries) {
    const classified = classifyEntry(entry, isImportable);
    if (classified.kind === "folder") continue;
    if (classified.kind === "skip") {
      skipped.push({ path: entry.name, reason: classified.reason });
      if (classified.segments) contentPaths.push(classified.segments);
      continue;
    }
    extract.push({ entry, segments: classified.segments });
    contentPaths.push(classified.segments);
  }

  const expandedBytes = extract.reduce((sum, { entry }) => sum + entry.size, 0);
  if (expandedBytes > maxExpandedBytes) {
    throw new Error(`Its files expand to more than ${Math.round(maxExpandedBytes / MIB)} MB. Split it into smaller ZIPs.`);
  }

  const wrapper = contentPaths[0]?.[0];
  const stripWrapper = wrapper !== undefined &&
    contentPaths.every((segments) => segments.length > 1 && segments[0] === wrapper);

  const totalBytes = extract.reduce((sum, { entry }) => sum + entry.compressedSize, 0);
  let doneBytes = 0;
  const report = () => onProgress?.(totalBytes > 0 ? Math.min(1, doneBytes / totalBytes) : 1);
  const slice = timeSlicer(signal, report);
  const files: ImportFileBytes[] = [];
  for (const { entry, segments } of extract) {
    await slice();
    try {
      const data = entryData(zip, entry);
      const expanded = await expandEntry(data, entry, slice, (count) => { doneBytes += count; });
      files.push({ name: (stripWrapper ? segments.slice(1) : segments).join("/"), bytes: expanded });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof DamagedEntryError) && !(error instanceof ZipFormatError)) throw error;
      skipped.push({ path: entry.name, reason: "damaged" });
      doneBytes += entry.compressedSize;
    }
  }
  report();
  return { files, skipped };
}

const SKIP_LABELS: Record<ZipSkipReason, [one: string, many: string]> = {
  unsupported: ["file Haptic can't import", "files Haptic can't import"],
  metadata: ["macOS metadata or hidden file", "macOS metadata and hidden files"],
  "nested-zip": ["ZIP inside the ZIP (import it on its own)", "ZIPs inside the ZIP (import them on their own)"],
  "unsafe-path": ["file with an absolute, \"..\" or invalid path", "files with absolute, \"..\" or invalid paths"],
  encrypted: ["encrypted file", "encrypted files"],
  compression: ["file compressed with a method other than Deflate", "files compressed with a method other than Deflate"],
  damaged: ["damaged file", "damaged files"],
};

const MAX_LISTED_ENTRIES = 5;

/** One line per reason entries were skipped, naming the first few, for the import issues list. */
export function describeSkippedZipEntries(skipped: readonly SkippedZipEntry[]): string[] {
  const lines: string[] = [];
  for (const reason of Object.keys(SKIP_LABELS) as ZipSkipReason[]) {
    const paths = skipped.filter((entry) => entry.reason === reason).map((entry) => entry.path);
    if (paths.length === 0) continue;
    const [one, many] = SKIP_LABELS[reason];
    const listed = paths.slice(0, MAX_LISTED_ENTRIES).join(", ");
    const more = paths.length > MAX_LISTED_ENTRIES ? ` and ${paths.length - MAX_LISTED_ENTRIES} more` : "";
    lines.push(`Skipped ${paths.length} ${paths.length === 1 ? one : many}: ${listed}${more}.`);
  }
  return lines;
}

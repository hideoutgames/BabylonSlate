import {
  concatBytes,
  readU32LE,
  sha256Hex,
  stableStringify,
  writeU32LE,
} from "./bytes";
import { AssetFormatVersionError } from "./migration";
import { ASSET_DEPENDENCY_METADATA_VERSION } from "./asset-dependencies";

export const HASSET_MAGIC = new TextEncoder().encode("HAPT");
export const HASSET_FORMAT_VERSION = 1;
export const HASSET_PREFIX_BYTES = 12;
/** Reject corrupt lengths before allocating a catalog header. */
export const MAX_HASSET_HEADER_BYTES = 16 * 1024 * 1024;
/** Chunks at or above this size externalise to the blob store in thin mode. */
export const DEFAULT_BLOB_THRESHOLD = 64 * 1024;

export type ChunkLocator =
  | { inline: { offset: number; length: number } }
  | { blob: string };

export interface ChunkEntry {
  id: string;
  kind: string;
  mime: string;
  sha256: string;
  byteLength: number;
  locator: ChunkLocator;
}

export interface HassetConsoleCommandParameter {
  name: string;
  type: "string" | "float" | "int" | "bool" | "enum";
  optional?: boolean;
  defaultValue?: unknown;
  enumValues?: string[];
}

export interface HassetConsoleCommandMetadata {
  name: string;
  description: string;
  category: string;
  parameters: HassetConsoleCommandParameter[];
}

export interface HassetHeader {
  chunks: ChunkEntry[];
  dependencies: string[];
  /** Complete references above; only these edges prepare an immediate consumer. */
  requiredDependencies: string[];
  /** Class properties consumed by synchronous graph readers; applies to instance overrides. */
  requiredVariableNames?: string[];
  classReferences?: string[];
  requiredClassReferences?: string[];
  consoleCommand?: HassetConsoleCommandMetadata;
  /** Always {@link ASSET_DEPENDENCY_METADATA_VERSION}; other values are refused. */
  dependencyMetadataVersion: number;
  engineVersion: string;
  guid: string;
  mode: "thin" | "bundled";
  name: string;
  parentClass?: string | null;
  payload: Record<string, unknown>;
  type: string;
  version: number;
}

const CONSOLE_PARAM_TYPES = new Set(["string", "float", "int", "bool", "enum"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid .hasset header: ${label} must be a string`);
  return value;
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid .hasset header: ${label} must be an array`);
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") throw new Error(`Invalid .hasset header: ${label}[${i}] must be a string`);
  }
  return value as string[];
}

function validateChunkEntry(raw: unknown, index: number): ChunkEntry {
  if (!isPlainRecord(raw)) throw new Error(`Invalid .hasset header: chunks[${index}] must be an object`);
  const id = assertString(raw.id, `chunks[${index}].id`);
  const kind = assertString(raw.kind, `chunks[${index}].kind`);
  const mime = assertString(raw.mime, `chunks[${index}].mime`);
  const sha256 = assertString(raw.sha256, `chunks[${index}].sha256`);
  if (!isNonNegativeSafeInt(raw.byteLength)) {
    throw new Error(`Invalid .hasset header: chunks[${index}].byteLength must be a non-negative integer`);
  }
  const loc = raw.locator;
  if (!isPlainRecord(loc)) throw new Error(`Invalid .hasset header: chunks[${index}].locator must be an object`);
  let locator: ChunkLocator;
  if ("inline" in loc && isPlainRecord(loc.inline)) {
    if (!isNonNegativeSafeInt(loc.inline.offset) || !isNonNegativeSafeInt(loc.inline.length)) {
      throw new Error(`Invalid .hasset header: chunks[${index}].locator.inline must have non-negative integer offset and length`);
    }
    locator = { inline: { offset: loc.inline.offset, length: loc.inline.length } };
  } else if ("blob" in loc && typeof loc.blob === "string" && loc.blob.length > 0) {
    locator = { blob: loc.blob };
  } else {
    throw new Error(`Invalid .hasset header: chunks[${index}].locator must be inline or non-empty blob`);
  }
  return { id, kind, mime, sha256, byteLength: raw.byteLength, locator };
}

function validateConsoleCommand(raw: unknown): HassetConsoleCommandMetadata {
  if (!isPlainRecord(raw)) throw new Error("Invalid .hasset header: consoleCommand must be an object");
  const name = assertString(raw.name, "consoleCommand.name");
  const description = assertString(raw.description, "consoleCommand.description");
  const category = assertString(raw.category, "consoleCommand.category");
  if (!Array.isArray(raw.parameters)) throw new Error("Invalid .hasset header: consoleCommand.parameters must be an array");
  const parameters: HassetConsoleCommandParameter[] = [];
  for (let i = 0; i < raw.parameters.length; i++) {
    const param = raw.parameters[i];
    if (!isPlainRecord(param)) throw new Error(`Invalid .hasset header: consoleCommand.parameters[${i}] must be an object`);
    const pName = assertString(param.name, `consoleCommand.parameters[${i}].name`);
    if (typeof param.type !== "string" || !CONSOLE_PARAM_TYPES.has(param.type)) {
      throw new Error(`Invalid .hasset header: consoleCommand.parameters[${i}].type is invalid`);
    }
    if (param.optional !== undefined && typeof param.optional !== "boolean") {
      throw new Error(`Invalid .hasset header: consoleCommand.parameters[${i}].optional must be a boolean`);
    }
    const enumValues = param.enumValues === undefined
      ? undefined
      : assertStringArray(param.enumValues, `consoleCommand.parameters[${i}].enumValues`);
    const entry: HassetConsoleCommandParameter = {
      name: pName,
      type: param.type as HassetConsoleCommandParameter["type"],
    };
    if (param.optional !== undefined) entry.optional = param.optional;
    if ("defaultValue" in param && param.defaultValue !== undefined) entry.defaultValue = param.defaultValue;
    if (enumValues !== undefined) entry.enumValues = enumValues;
    parameters.push(entry);
  }
  return { name, description, category, parameters };
}

/** Fast structural validator for `.hasset` headers (replaces Zod on the hot scan/read path). */
export function validateHassetHeader(raw: unknown): HassetHeader {
  if (!isPlainRecord(raw)) throw new Error("Invalid .hasset header: expected an object");
  if (!Array.isArray(raw.chunks)) throw new Error("Invalid .hasset header: chunks must be an array");
  const chunks: ChunkEntry[] = new Array(raw.chunks.length);
  for (let i = 0; i < raw.chunks.length; i++) {
    chunks[i] = validateChunkEntry(raw.chunks[i], i);
  }
  const dependencies = assertStringArray(raw.dependencies, "dependencies");
  const requiredDependencies = assertStringArray(raw.requiredDependencies, "requiredDependencies");
  if (!isNonNegativeSafeInt(raw.dependencyMetadataVersion)) {
    throw new Error("Invalid .hasset header: dependencyMetadataVersion must be a non-negative integer");
  }
  const engineVersion = assertString(raw.engineVersion, "engineVersion");
  const guid = assertString(raw.guid, "guid");
  const mode = raw.mode === undefined ? "thin" : raw.mode;
  if (mode !== "thin" && mode !== "bundled") {
    throw new Error(`Invalid .hasset header: unsupported mode ${String(mode)}`);
  }
  const name = assertString(raw.name, "name");
  if (raw.parentClass !== undefined && raw.parentClass !== null && typeof raw.parentClass !== "string") {
    throw new Error("Invalid .hasset header: parentClass must be a string or null");
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainRecord(payload)) {
    throw new Error("Invalid .hasset header: payload must be an object");
  }
  const type = assertString(raw.type, "type");
  if (!isNonNegativeSafeInt(raw.version)) {
    throw new Error("Invalid .hasset header: version must be a non-negative integer");
  }
  const header: HassetHeader = {
    chunks,
    dependencies,
    requiredDependencies,
    dependencyMetadataVersion: raw.dependencyMetadataVersion,
    engineVersion,
    guid,
    mode,
    name,
    payload,
    type,
    version: raw.version,
  };
  if (raw.requiredVariableNames !== undefined) {
    header.requiredVariableNames = assertStringArray(raw.requiredVariableNames, "requiredVariableNames");
  }
  if (raw.classReferences !== undefined) {
    header.classReferences = assertStringArray(raw.classReferences, "classReferences");
  }
  if (raw.requiredClassReferences !== undefined) {
    header.requiredClassReferences = assertStringArray(raw.requiredClassReferences, "requiredClassReferences");
  }
  if (raw.consoleCommand !== undefined) {
    header.consoleCommand = validateConsoleCommand(raw.consoleCommand);
  }
  if (raw.parentClass !== undefined) {
    header.parentClass = raw.parentClass;
  }
  return header;
}

export interface ChunkInput {
  id: string;
  kind: string;
  mime: string;
  data: Uint8Array;
}

/**
 * A chunk an existing container already holds, written again without hashing
 * it or uploading it: the table's digest and length are kept as they are. An
 * externalised chunk stays in the blob store; an inline chunk's bytes are
 * copied. The caller owns the proof that those bytes are the ones the digest
 * names (see `carryStoredChunks`), because nothing here re-reads a blob.
 */
export interface CarriedChunkInput {
  id: string;
  kind: string;
  mime: string;
  carried: { sha256: string; byteLength: number } & ({ blob: string } | { bytes: Uint8Array });
}

/** A chunk to write: new bytes, or one carried from the container being replaced. */
export type EncodableChunk = ChunkInput | CarriedChunkInput;

export function isCarriedChunk(chunk: EncodableChunk): chunk is CarriedChunkInput {
  return "carried" in chunk;
}

export interface EncodeHassetOptions {
  header: Omit<HassetHeader, "chunks">;
  chunks: EncodableChunk[];
  /** When set, chunks >= threshold use blob locators (thin mode). */
  blobThreshold?: number;
  /** Existing blob store writer; required when externalising. */
  writeBlob?: (sha256: string, data: Uint8Array) => Promise<void>;
  /**
   * Bundled mode: dependency assets embedded as nested `asset` chunks.
   * Each entry's bytes should already be a complete .hasset.
   */
  nestedAssets?: Array<{ guid: string; bytes: Uint8Array }>;
}

export interface DecodedHasset {
  header: HassetHeader;
  /** Absolute file offsets are resolved; payloads may be empty for header-only. */
  chunks: Map<string, Uint8Array>;
  /** Nested dependency assets unpacked from bundled mode. */
  nestedAssets: Map<string, Uint8Array>;
}

function assertMagic(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== HASSET_MAGIC[0] ||
    bytes[1] !== HASSET_MAGIC[1] ||
    bytes[2] !== HASSET_MAGIC[2] ||
    bytes[3] !== HASSET_MAGIC[3]
  ) {
    throw new Error("Not a .hasset file (bad magic)");
  }
}

/**
 * Read header + chunk table without allocating chunk payloads.
 */
export function readHassetHeaderLength(bytes: Uint8Array): number {
  if (bytes.byteLength < HASSET_PREFIX_BYTES) throw new Error("Truncated .hasset prefix");
  assertMagic(bytes);
  const formatVersion = readU32LE(bytes, 4);
  if (formatVersion !== HASSET_FORMAT_VERSION) {
    throw new Error(`Unsupported .hasset format version ${formatVersion}`);
  }
  const headerLen = readU32LE(bytes, 8);
  if (headerLen === 0 || headerLen > MAX_HASSET_HEADER_BYTES) {
    throw new Error(`Invalid .hasset header length ${headerLen}`);
  }
  return headerLen;
}

/**
 * Refuse a header written before chunk lengths and dependency metadata
 * version {@link ASSET_DEPENDENCY_METADATA_VERSION}, the released layout.
 * Such pre-release files are not upgraded.
 */
function assertCurrentHeaderLayout(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const header = raw as Record<string, unknown>;
  const asset = typeof header.guid === "string" ? `Asset ${header.guid}` : ".hasset";
  const version = header.dependencyMetadataVersion;
  if (typeof version === "number" && version > ASSET_DEPENDENCY_METADATA_VERSION) {
    throw new AssetFormatVersionError(
      `${asset} dependency metadata version ${version} was made with a newer engine version (current ${ASSET_DEPENDENCY_METADATA_VERSION})`,
    );
  }
  const missing: string[] = [];
  if (version !== ASSET_DEPENDENCY_METADATA_VERSION) missing.push("dependencyMetadataVersion");
  for (const field of ["dependencies", "requiredDependencies"]) {
    if (!Array.isArray(header[field])) missing.push(field);
  }
  if (header.type === "Class" && !Array.isArray(header.requiredVariableNames)) missing.push("requiredVariableNames");
  if (Array.isArray(header.chunks) && header.chunks.some((chunk) => !chunk || typeof chunk !== "object" || !("byteLength" in chunk))) {
    missing.push("chunk byteLength");
  }
  if (missing.length) {
    throw new AssetFormatVersionError(
      `${asset} uses an unsupported old .hasset layout (missing ${missing.join(", ")}). This engine reads dependency metadata version ${ASSET_DEPENDENCY_METADATA_VERSION} with chunk lengths; older files are not upgraded.`,
    );
  }
}

/** Validate a header in the current layout; older layouts throw {@link AssetFormatVersionError}. */
function parseHassetHeader(raw: unknown): HassetHeader {
  assertCurrentHeaderLayout(raw);
  return validateHassetHeader(raw);
}

/** Shared: a non-streaming `decode` keeps no state between calls. */
const headerDecoder = new TextDecoder();

export function readHassetHeader(bytes: Uint8Array): HassetHeader {
  const headerLen = readHassetHeaderLength(bytes);
  if (bytes.byteLength < HASSET_PREFIX_BYTES + headerLen) throw new Error("Truncated .hasset header");
  const headerBytes = bytes.subarray(HASSET_PREFIX_BYTES, HASSET_PREFIX_BYTES + headerLen);
  const json = headerDecoder.decode(headerBytes);
  return parseHassetHeader(JSON.parse(json));
}

export async function encodeHasset(
  options: EncodeHassetOptions,
): Promise<Uint8Array> {
  const threshold = options.blobThreshold ?? DEFAULT_BLOB_THRESHOLD;
  const mode = options.header.mode ?? "thin";
  const chunkBytes: Uint8Array[] = [];
  const table: ChunkEntry[] = [];
  let inlineOffset = 0;

  const allChunks: EncodableChunk[] = [...options.chunks];
  if (mode === "bundled" && options.nestedAssets) {
    for (const nested of options.nestedAssets) {
      allChunks.push({
        id: `nested:${nested.guid}`,
        kind: "asset",
        mime: "application/vnd.haptic.hasset",
        data: nested.bytes,
      });
    }
  }

  for (const chunk of allChunks) {
    if (isCarriedChunk(chunk)) {
      const { sha256, byteLength } = chunk.carried;
      if ("blob" in chunk.carried) {
        if (mode !== "thin") throw new Error(`Chunk ${chunk.id} lives in the blob store, which a ${mode} asset does not use`);
        table.push({
          id: chunk.id,
          kind: chunk.kind,
          mime: chunk.mime,
          sha256,
          byteLength,
          locator: { blob: chunk.carried.blob },
        });
      } else {
        if (chunk.carried.bytes.byteLength !== byteLength) {
          throw new Error(`Carried chunk ${chunk.id} does not have its recorded length`);
        }
        table.push({
          id: chunk.id,
          kind: chunk.kind,
          mime: chunk.mime,
          sha256,
          byteLength,
          locator: { inline: { offset: inlineOffset, length: byteLength } },
        });
        chunkBytes.push(chunk.carried.bytes);
        inlineOffset += byteLength;
      }
      continue;
    }
    const hash = await sha256Hex(chunk.data);
    const externalise =
      mode === "thin" && chunk.data.byteLength >= threshold && options.writeBlob;

    if (externalise) {
      await options.writeBlob!(hash, chunk.data);
      table.push({
        id: chunk.id,
        kind: chunk.kind,
        mime: chunk.mime,
        sha256: hash,
        byteLength: chunk.data.byteLength,
        locator: { blob: hash },
      });
    } else {
      table.push({
        id: chunk.id,
        kind: chunk.kind,
        mime: chunk.mime,
        sha256: hash,
        byteLength: chunk.data.byteLength,
        locator: {
          inline: { offset: inlineOffset, length: chunk.data.byteLength },
        },
      });
      chunkBytes.push(chunk.data);
      inlineOffset += chunk.data.byteLength;
    }
  }

  // A writer must never produce a file the reader refuses.
  const header: HassetHeader = parseHassetHeader({
    ...options.header,
    mode,
    chunks: table,
  });
  const headerJson = stableStringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  if (headerBytes.byteLength > MAX_HASSET_HEADER_BYTES) throw new Error(".hasset header exceeds the catalog size limit");

  return concatBytes([
    HASSET_MAGIC,
    writeU32LE(HASSET_FORMAT_VERSION),
    writeU32LE(headerBytes.byteLength),
    headerBytes,
    ...chunkBytes,
  ]);
}

/** One chunk's bytes, checked against its recorded length and sha256. */
async function readVerifiedChunk(
  bytes: Uint8Array,
  payloadStart: number,
  entry: ChunkEntry,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  let data: Uint8Array;
  if ("inline" in entry.locator) {
    const { offset, length } = entry.locator.inline;
    const end = payloadStart + offset + length;
    if (end > bytes.byteLength || entry.byteLength !== length) {
      throw new Error(`Truncated or invalid chunk ${entry.id} in .hasset`);
    }
    data = bytes.subarray(payloadStart + offset, end);
  } else {
    if (!readBlob) {
      throw new Error(
        `Chunk ${entry.id} uses a blob locator but no readBlob was provided`,
      );
    }
    data = await readBlob(entry.locator.blob);
    if (data.byteLength !== entry.byteLength) {
      throw new Error(`Length mismatch for chunk ${entry.id} in .hasset`);
    }
  }
  if ((await sha256Hex(data)) !== entry.sha256) {
    throw new Error(`Hash mismatch for chunk ${entry.id} in .hasset`);
  }
  return data;
}

/**
 * Decode one chunk, verified like {@link decodeHasset}, without reading or
 * hashing the others. Null when the file has no chunk with that id.
 */
export async function decodeHassetChunk(
  bytes: Uint8Array,
  chunkId: string,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  const header = readHassetHeader(bytes);
  const entry = header.chunks.find((chunk) => chunk.id === chunkId);
  if (!entry) return null;
  return readVerifiedChunk(bytes, HASSET_PREFIX_BYTES + readU32LE(bytes, 8), entry, readBlob);
}

/**
 * The writer lays inline chunks end to end, so no two share a byte. A file
 * whose chunks overlap is refused: it could name one nested asset many times
 * over and multiply the work of reading it with every level of nesting.
 */
function assertDisjointInlineChunks(entries: readonly ChunkEntry[]): void {
  const ranges: Array<{ offset: number; end: number; id: string }> = [];
  for (const entry of entries) {
    if (!("inline" in entry.locator) || entry.locator.inline.length === 0) continue;
    const { offset, length } = entry.locator.inline;
    ranges.push({ offset, end: offset + length, id: entry.id });
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.offset < ranges[index - 1]!.end) {
      throw new Error(`Chunks ${ranges[index - 1]!.id} and ${ranges[index]!.id} overlap in .hasset`);
    }
  }
}

/**
 * Decode every chunk. Each one must have its recorded length and sha256, so a
 * truncated file or a torn blob is rejected rather than returned as the chunk,
 * and no two inline chunks may share bytes.
 */
export async function decodeHasset(
  bytes: Uint8Array,
  readBlob?: (sha256: string) => Promise<Uint8Array>,
): Promise<DecodedHasset> {
  const header = readHassetHeader(bytes);
  const headerLen = readU32LE(bytes, 8);
  const payloadStart = HASSET_PREFIX_BYTES + headerLen;
  assertDisjointInlineChunks(header.chunks);
  const chunks = new Map<string, Uint8Array>();
  const nestedAssets = new Map<string, Uint8Array>();

  for (const entry of header.chunks) {
    const data = await readVerifiedChunk(bytes, payloadStart, entry, readBlob);
    chunks.set(entry.id, data);
    if (entry.kind === "asset" && entry.id.startsWith("nested:")) {
      nestedAssets.set(entry.id.slice("nested:".length), data);
    }
  }

  return { header, chunks, nestedAssets };
}

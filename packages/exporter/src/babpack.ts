import {
  concatBytes,
  readU32LE,
  sha256Hex,
  writeU32LE,
} from "@babylonslate/assets";
import { BABPACK_MAGIC } from "./constants";

export type BabpackBlob = {
  guid: string;
  bytes: Uint8Array;
};

export type BabpackEntry = {
  guid: string;
  offset: number;
  length: number;
  hash: string;
};

export type DecodedBabpack = {
  entries: BabpackEntry[];
  read: (guid: string) => Uint8Array;
};

const MAGIC = new TextEncoder().encode(BABPACK_MAGIC);

export async function encodeBabpack(blobs: readonly BabpackBlob[]): Promise<Uint8Array> {
  const payloadParts: Uint8Array[] = [];
  const meta: Array<{
    guid: string;
    length: number;
    hash: string;
    payloadOffset: number;
  }> = [];
  let payloadOffset = 0;
  for (const blob of blobs) {
    const hash = await sha256Hex(blob.bytes);
    meta.push({
      guid: blob.guid,
      length: blob.bytes.byteLength,
      hash,
      payloadOffset,
    });
    payloadParts.push(blob.bytes);
    payloadOffset += blob.bytes.byteLength;
  }

  let headerLen = 8;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entries: BabpackEntry[] = meta.map((entry) => ({
      guid: entry.guid,
      offset: headerLen + entry.payloadOffset,
      length: entry.length,
      hash: entry.hash,
    }));
    const index = new TextEncoder().encode(JSON.stringify({ entries }));
    const header = concatBytes([MAGIC, writeU32LE(index.byteLength), index]);
    if (header.byteLength === headerLen) {
      return concatBytes([header, ...payloadParts]);
    }
    headerLen = header.byteLength;
  }
  throw new Error("Invalid babpack: header length did not stabilize");
}

export function decodeBabpackIndex(bytes: Uint8Array): BabpackEntry[] {
  if (bytes.byteLength < 8) {
    throw new Error("Invalid babpack: truncated header");
  }
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== BABPACK_MAGIC) {
    throw new Error("Invalid babpack: bad magic");
  }
  const indexLen = readU32LE(bytes, 4);
  const indexStart = 8;
  const indexEnd = indexStart + indexLen;
  if (indexEnd > bytes.byteLength) {
    throw new Error("Invalid babpack: truncated index");
  }
  let parsed: { entries?: BabpackEntry[] };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(indexStart, indexEnd))) as {
      entries?: BabpackEntry[];
    };
  } catch {
    throw new Error("Invalid babpack: index is not JSON");
  }
  return parsed.entries ?? [];
}

export function decodeBabpack(bytes: Uint8Array): DecodedBabpack {
  const entries = decodeBabpackIndex(bytes);
  const byGuid = new Map(entries.map((entry) => [entry.guid, entry]));
  return {
    entries,
    read(guid: string) {
      const entry = byGuid.get(guid);
      if (!entry) throw new Error(`Invalid babpack: missing ${guid}`);
      const end = entry.offset + entry.length;
      if (entry.offset < 0 || end > bytes.byteLength) {
        throw new Error(`Invalid babpack: truncated payload for ${guid}`);
      }
      return bytes.subarray(entry.offset, end);
    },
  };
}

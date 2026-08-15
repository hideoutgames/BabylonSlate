import { readU32LE } from "@babylonslate/assets";
import {
  decodeBabpack,
  decodeBabpackIndex,
  type BabpackEntry,
  type DecodedBabpack,
} from "./babpack";

export type PackSource = {
  read: (guid: string) => Promise<Uint8Array>;
};

export function createMemoryPackSource(pack: Uint8Array): PackSource {
  const decoded = decodeBabpack(pack);
  return {
    async read(guid: string) {
      return decoded.read(guid);
    },
  };
}

function rangeHeaders(offset: number, length: number): Record<string, string> {
  return { Range: `bytes=${offset}-${offset + length - 1}` };
}

function isWholeBody(status: number, body: Uint8Array, expected?: number): boolean {
  if (status === 200) return true;
  if (status !== 206) return false;
  return expected !== undefined && body.byteLength > expected;
}

export function createHttpPackSource(
  url: string,
  knownPack?: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): PackSource {
  let decoded: DecodedBabpack | null = knownPack ? decodeBabpack(knownPack) : null;
  let entries: BabpackEntry[] | null = decoded?.entries ?? null;

  async function loadWhole(): Promise<DecodedBabpack> {
    const response = await fetchImpl(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    decoded = decodeBabpack(bytes);
    entries = decoded.entries;
    return decoded;
  }

  async function ensureIndex(): Promise<BabpackEntry[]> {
    if (entries) return entries;
    const probe = await fetchImpl(url, { headers: rangeHeaders(0, 8) });
    const probeBytes = new Uint8Array(await probe.arrayBuffer());
    if (isWholeBody(probe.status, probeBytes, 8)) {
      decoded = decodeBabpack(probeBytes);
      entries = decoded.entries;
      return entries;
    }
    if (probe.status !== 206 || probeBytes.byteLength < 8) {
      return (await loadWhole()).entries;
    }
    const indexLen = readU32LE(probeBytes, 4);
    const headerLen = 8 + indexLen;
    const headerResp = await fetchImpl(url, {
      headers: rangeHeaders(0, headerLen),
    });
    const headerBytes = new Uint8Array(await headerResp.arrayBuffer());
    if (isWholeBody(headerResp.status, headerBytes, headerLen)) {
      decoded = decodeBabpack(headerBytes);
      entries = decoded.entries;
      return entries;
    }
    if (headerResp.status !== 206) {
      return (await loadWhole()).entries;
    }
    entries = decodeBabpackIndex(headerBytes);
    return entries;
  }

  return {
    async read(guid: string) {
      const index = await ensureIndex();
      const entry = index.find((item) => item.guid === guid);
      if (!entry) throw new Error(`Pack is missing ${guid}`);
      if (decoded) return decoded.read(guid);
      const response = await fetchImpl(url, {
        headers: rangeHeaders(entry.offset, entry.length),
      });
      const body = new Uint8Array(await response.arrayBuffer());
      if (response.status === 206 && body.byteLength === entry.length) {
        return body;
      }
      if (body.byteLength > entry.length) {
        decoded = decodeBabpack(body);
        entries = decoded.entries;
        return decoded.read(guid);
      }
      return (await loadWhole()).read(guid);
    },
  };
}

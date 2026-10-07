import { readU32LE, sha256Hex } from "@babylonslate/assets";
import type { StorageReadMetrics } from "@babylonslate/core";
import { decodeBabpack, decodeBabpackIndex, type BabpackEntry, type DecodedBabpack } from "./babpack";

export type PackSource = {
  read: (guid: string) => Promise<Uint8Array>;
  getReadMetrics?: () => StorageReadMetrics;
};
const metrics = (): StorageReadMetrics => ({ operations: 0, fullReads: 0, rangeReads: 0, requestedBytes: 0, actualBytesRead: 0 });
async function verify(entry: BabpackEntry, bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength !== entry.length || await sha256Hex(bytes) !== entry.hash) throw new Error(`Corrupt pack payload for ${entry.guid}`);
  return bytes;
}

export function createMemoryPackSource(pack: Uint8Array): PackSource {
  const decoded = decodeBabpack(pack);
  const stats = { ...metrics(), operations: 1, fullReads: 1, requestedBytes: pack.byteLength, actualBytesRead: pack.byteLength };
  return {
    async read(guid) {
      const entry = decoded.entries.find(value => value.guid === guid);
      if (!entry) throw new Error(`Pack is missing ${guid}`);
      return verify(entry, decoded.read(guid));
    },
    getReadMetrics: () => ({ ...stats }),
  };
}

/** Legacy packs only. New exports use independent files, avoiding range support requirements. */
export function createHttpPackSource(url: string, knownPack?: Uint8Array, fetchImpl: typeof fetch = fetch): PackSource {
  let decoded: DecodedBabpack | null = knownPack ? decodeBabpack(knownPack) : null;
  let entries: BabpackEntry[] | null = decoded?.entries ?? null;
  let indexLoad: Promise<BabpackEntry[]> | null = null;
  let revision: string | null = null;
  let totalSize: number | undefined = knownPack?.byteLength;
  const stats = metrics();

  async function range(offset: number, length: number): Promise<Uint8Array> {
    const response = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, ...(revision ? { "If-Match": revision } : {}) } });
    if (!response.ok) throw new Error(`Could not load pack: HTTP ${response.status}`);
    const body = new Uint8Array(await response.arrayBuffer());
    stats.operations++; stats.requestedBytes += length; stats.actualBytesRead += body.byteLength;
    if (response.status === 200) stats.fullReads++; else stats.rangeReads++;
    const etag = response.headers.get("ETag");
    if (revision && etag !== revision) throw new Error("Pack revision changed while loading.");
    if (etag) revision = etag;
    if (response.status === 200) {
      // Retain the complete legacy response and explicitly account every byte.
      decoded = decodeBabpack(body);
      totalSize = body.byteLength;
      return body;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    if (response.status !== 206 || !match || Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1 || body.byteLength !== length) throw new Error("Invalid pack HTTP range response.");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < offset + length || (totalSize !== undefined && size !== totalSize)) throw new Error("Pack length changed while loading.");
    totalSize = size;
    return body;
  }

  async function loadIndex(): Promise<BabpackEntry[]> {
    const prefix = await range(0, 8);
    if (decoded) return decoded.entries;
    const indexLength = readU32LE(prefix, 4);
    if (indexLength > 16 * 1024 * 1024 || indexLength + 8 > totalSize!) throw new Error("Invalid pack index length.");
    const header = await range(0, 8 + indexLength);
    const whole = decoded as DecodedBabpack | null;
    const index = whole ? whole.entries : decodeBabpackIndex(header);
    const seen = new Set<string>();
    for (const entry of index) {
      if (!entry.guid || seen.has(entry.guid) || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) || entry.offset < 8 + indexLength || entry.length < 0 || entry.offset + entry.length > totalSize! || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error("Invalid pack entry bounds or identity.");
      seen.add(entry.guid);
    }
    return index;
  }
  return {
    async read(guid) {
      if (!entries) {
        indexLoad ??= loadIndex().then(value => entries = value).finally(() => { indexLoad = null; });
        await indexLoad;
      }
      const entry = entries!.find(value => value.guid === guid);
      if (!entry) throw new Error(`Pack is missing ${guid}`);
      if (decoded) return verify(entry, decoded.read(guid));
      if (entry.length === 0) return verify(entry, new Uint8Array());
      const bytes = await range(entry.offset, entry.length);
      const whole = decoded as DecodedBabpack | null;
      return verify(entry, whole ? whole.read(guid) : bytes);
    },
    getReadMetrics: () => ({ ...stats }),
  };
}

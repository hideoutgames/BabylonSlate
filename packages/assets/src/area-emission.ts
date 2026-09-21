import type { BabassetHeader } from "./babasset";
import { concatBytes, readU32LE, sha256Hex, writeU32LE } from "./bytes";

/** Version includes native encoding, filtering, color space and row orientation. */
export const AREA_EMISSION_PROCESSOR = "babylon-9.20-rgba8-1024-v2";
export const AREA_EMISSION_EDGE = 1024;
export const AREA_EMISSION_CHUNK_KIND = "area-emission";
const MAGIC = new TextEncoder().encode("BARE");
export type AreaEmissionMetadata = {
  processor: typeof AREA_EMISSION_PROCESSOR;
  sourceHash: string;
  pixelsHash: string;
  width: typeof AREA_EMISSION_EDGE;
  height: typeof AREA_EMISSION_EDGE;
  encoding: "rgba8-display-bottom-left";
};
export type AreaEmissionPixels = { metadata: AreaEmissionMetadata; rgba: Uint8Array };
export type AreaEmissionProgress = { phase: "queued" | "decoding" | "filtering" | "saving"; progress: number };

export function areaEmissionChunkId(sourceHash: string): string {
  return `area-emission:${AREA_EMISSION_PROCESSOR}:${sourceHash}`;
}

/** Source hash is authoritative; a replaced image can never reuse stale lighting. */
export function currentAreaEmissionChunk(header: BabassetHeader) {
  if (header.type !== "Texture") return undefined;
  const source = header.chunks.find((chunk) => chunk.id === "pixels" || chunk.kind === "pixels");
  return source && header.chunks.find((chunk) => chunk.id === areaEmissionChunkId(source.sha256) && chunk.kind === AREA_EMISSION_CHUNK_KIND);
}

export async function encodeAreaEmission(rgba: Uint8Array, sourceHash: string): Promise<Uint8Array> {
  if (rgba.byteLength !== AREA_EMISSION_EDGE ** 2 * 4 || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Invalid area emission processing result.");
  const metadata: AreaEmissionMetadata = { processor: AREA_EMISSION_PROCESSOR, sourceHash, pixelsHash: await sha256Hex(rgba), width: AREA_EMISSION_EDGE, height: AREA_EMISSION_EDGE, encoding: "rgba8-display-bottom-left" };
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  return concatBytes([MAGIC, writeU32LE(header.byteLength), header, rgba]);
}

export async function decodeAreaEmission(bytes: Uint8Array, expectedSourceHash?: string): Promise<AreaEmissionPixels> {
  if (bytes.byteLength < 8 || MAGIC.some((value, index) => value !== bytes[index])) throw new Error("Invalid area emission header.");
  const length = readU32LE(bytes, 4);
  if (length > 2048 || bytes.byteLength !== 8 + length + AREA_EMISSION_EDGE ** 2 * 4) throw new Error("Invalid area emission size.");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as AreaEmissionMetadata;
  if (metadata.processor !== AREA_EMISSION_PROCESSOR || metadata.width !== AREA_EMISSION_EDGE || metadata.height !== AREA_EMISSION_EDGE || metadata.encoding !== "rgba8-display-bottom-left" || !/^[a-f0-9]{64}$/.test(metadata.sourceHash) || (expectedSourceHash && expectedSourceHash !== metadata.sourceHash)) throw new Error("Stale or unsupported area emission asset. Process the Texture again.");
  const rgba = bytes.subarray(8 + length);
  if (await sha256Hex(rgba) !== metadata.pixelsHash) throw new Error("Corrupt area emission pixels.");
  return { metadata, rgba };
}

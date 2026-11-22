import {
  decodeFoliageBase64ToBytes,
  decodeFoliageChunk,
  foliageBatchInfos,
  foliageChunkId,
  isFoliageChunkId,
} from "@haptic/core";
import type { ChunkInput } from "./hasset";
import { mapPayloadComponents } from "./landscape-chunks";

export const FOLIAGE_CHUNK_KIND = "foliage";
export const FOLIAGE_CHUNK_MIME = "application/octet-stream";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

/** Raw `HPFG` bytes of base64 `data` when they decode and match the component's batch list, else null. */
function validDataBytes(properties: Record<string, unknown>): Uint8Array | null {
  const data = typeof properties.data === "string" && properties.data.length > 0 ? properties.data : null;
  if (!data) return null;
  try {
    const bytes = decodeFoliageBase64ToBytes(data);
    return decodeFoliageChunk(bytes).length === foliageBatchInfos(properties).length ? bytes : null;
  } catch {
    return null;
  }
}

function validChunk(bytes: Uint8Array | undefined, properties: Record<string, unknown>): bytes is Uint8Array {
  if (!bytes) return false;
  try {
    return decodeFoliageChunk(bytes).length === foliageBatchInfos(properties).length;
  } catch {
    return false;
  }
}

/**
 * Moves every `FoliageComponent`'s base64 `data` in a Scene, Prefab or Class payload into a raw binary `HPFG`
 * `.hasset` chunk (`foliage:<componentId>`) named by `chunkId`, so the stored JSON holds no instance. Unreadable data is
 * dropped; a component with nothing painted emits no chunk.
 */
export function extractFoliageChunks<T>(payload: T): { payload: T; chunks: ChunkInput[] } {
  const chunks: ChunkInput[] = [];
  const nextPayload = mapPayloadComponents(payload, (component) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object" || !("data" in props)) return component;
    const bytes = validDataBytes(props);
    const nextProps: Record<string, unknown> = { ...props };
    delete nextProps.data;
    delete nextProps.chunkId;
    if (bytes) {
      const chunkId = foliageChunkId(component.id);
      chunks.push({ id: chunkId, kind: FOLIAGE_CHUNK_KIND, mime: FOLIAGE_CHUNK_MIME, data: bytes });
      nextProps.chunkId = chunkId;
    }
    return { ...component, properties: nextProps };
  });
  return { payload: nextPayload, chunks };
}

/** Restores `foliage:*` chunks into base64 `data` for editor documents (undo, journal, copy and paste). */
export function hydrateFoliageChunksToEditor<T>(payload: T, chunks: ReadonlyMap<string, Uint8Array>): T {
  if (chunks.size === 0) return payload;
  return mapPayloadComponents(payload, (component) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    const chunkId = typeof props.chunkId === "string" && isFoliageChunkId(props.chunkId) ? props.chunkId : null;
    if (!chunkId) return component;
    const bytes = chunks.get(chunkId);
    if (!validChunk(bytes, props)) return component;
    const nextProps: Record<string, unknown> = { ...props, data: bytesToBase64(bytes) };
    delete nextProps.chunkId;
    return { ...component, properties: nextProps };
  });
}

/**
 * Prepares a payload and its raw `HPFG` chunks for Play or export, so no base64 reaches the runtime: unsaved editor
 * `data` is decoded once into a chunk named by `chunkId`, and a stored `chunkId` reuses its bytes from `storedChunks`.
 */
export function collectFoliageChunksForPlay<T>(
  payload: T,
  storedChunks?: ReadonlyMap<string, Uint8Array>,
): { payload: T; chunks: Map<string, Uint8Array> } {
  const chunks = new Map<string, Uint8Array>();
  const nextPayload = mapPayloadComponents(payload, (component) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    if ("data" in props) {
      const bytes = validDataBytes(props);
      const nextProps: Record<string, unknown> = { ...props };
      delete nextProps.data;
      delete nextProps.chunkId;
      if (bytes) {
        const chunkId = foliageChunkId(component.id);
        chunks.set(chunkId, bytes);
        nextProps.chunkId = chunkId;
      }
      return { ...component, properties: nextProps };
    }
    const chunkId = typeof props.chunkId === "string" && isFoliageChunkId(props.chunkId) ? props.chunkId : null;
    const bytes = chunkId ? storedChunks?.get(chunkId) : undefined;
    if (chunkId && validChunk(bytes, props)) chunks.set(chunkId, bytes);
    return component;
  });
  return { payload: nextPayload, chunks };
}

/** Every `foliage:*` chunk id in a `.hasset` chunk table. */
export function foliageChunkIdsInHeader(chunks: ReadonlyArray<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    if (isFoliageChunkId(chunk.id)) ids.push(chunk.id);
  }
  return ids;
}

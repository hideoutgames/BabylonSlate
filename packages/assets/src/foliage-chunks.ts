import {
  decodeFoliageBase64ToBytes,
  decodeFoliageChunk,
  foliageBatchInfos,
  foliageChunkId,
  isFoliageChunkId,
  type SerializedActor,
  type SerializedComponent,
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

/**
 * A Scene component's chunk id: `foliage:<actorId>/<componentId>`. Component ids are only unique within their actor
 * (every instance of one Prefab carries the Prefab's component ids), so the actor names the chunk too.
 */
export function sceneFoliageChunkId(component: SerializedComponent, actor: SerializedActor | undefined): string {
  return foliageChunkId(actor ? `${actor.id}/${component.id}` : component.id);
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

function hasData(properties: Record<string, unknown>): boolean {
  return typeof properties.data === "string" && properties.data.length > 0;
}

/**
 * Moves every Scene `FoliageComponent`'s base64 `data` into a raw binary `HPFG` `.hasset` chunk named by `chunkId`
 * (`sceneFoliageChunkId`), so the stored JSON holds no instance. A component with nothing painted emits no chunk. Data
 * that does not decode or does not match the component's batches is kept inline, never dropped, and listed in
 * `unreadable` (component ids) for the caller to report.
 */
export function extractFoliageChunks<T>(payload: T): { payload: T; chunks: ChunkInput[]; unreadable: string[] } {
  const chunks: ChunkInput[] = [];
  const unreadable: string[] = [];
  const nextPayload = mapPayloadComponents(payload, (component, actor) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object" || !("data" in props)) return component;
    if (!hasData(props)) {
      const nextProps: Record<string, unknown> = { ...props };
      delete nextProps.data;
      delete nextProps.chunkId;
      return { ...component, properties: nextProps };
    }
    const bytes = validDataBytes(props);
    if (!bytes) {
      unreadable.push(component.id);
      return component;
    }
    const chunkId = sceneFoliageChunkId(component, actor);
    chunks.push({ id: chunkId, kind: FOLIAGE_CHUNK_KIND, mime: FOLIAGE_CHUNK_MIME, data: bytes });
    const nextProps: Record<string, unknown> = { ...props, chunkId };
    delete nextProps.data;
    return { ...component, properties: nextProps };
  });
  return { payload: nextPayload, chunks, unreadable };
}

/**
 * Restores `foliage:*` chunks into base64 `data` for editor documents (undo, journal, copy and paste). A component
 * whose chunk is missing, malformed or does not match its batches keeps its `chunkId`, so a later save carries the
 * stored chunk unchanged; `onUnreadable` names it.
 */
export function hydrateFoliageChunksToEditor<T>(
  payload: T,
  chunks: ReadonlyMap<string, Uint8Array>,
  onUnreadable?: (componentId: string, chunkId: string) => void,
): T {
  return mapPayloadComponents(payload, (component) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    const chunkId = typeof props.chunkId === "string" && isFoliageChunkId(props.chunkId) ? props.chunkId : null;
    if (!chunkId) return component;
    const bytes = chunks.get(chunkId);
    if (!validChunk(bytes, props)) {
      onUnreadable?.(component.id, chunkId);
      return component;
    }
    const nextProps: Record<string, unknown> = { ...props, data: bytesToBase64(bytes) };
    delete nextProps.chunkId;
    return { ...component, properties: nextProps };
  });
}

/**
 * Prepares a Scene payload and its raw `HPFG` chunks for Play or export, so no base64 reaches the runtime: unsaved
 * editor `data` is decoded once into a chunk named by `chunkId`, and a stored `chunkId` reuses its bytes from
 * `storedChunks`. Each such component names `ownerGuid` as its `chunkOwner`, so the runtime finds its chunk at
 * `<ownerGuid>:<chunkId>` exactly. Prefab and Class documents keep their instances inline (`data`) and pass through.
 */
export function collectFoliageChunksForPlay<T>(
  payload: T,
  storedChunks: ReadonlyMap<string, Uint8Array> | undefined,
  ownerGuid: string,
): { payload: T; chunks: Map<string, Uint8Array> } {
  const chunks = new Map<string, Uint8Array>();
  const nextPayload = mapPayloadComponents(payload, (component, actor) => {
    if (component.classId !== "FoliageComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    if (hasData(props)) {
      const bytes = validDataBytes(props);
      if (!bytes) return component;
      const chunkId = sceneFoliageChunkId(component, actor);
      chunks.set(chunkId, bytes);
      const nextProps: Record<string, unknown> = { ...props, chunkId, chunkOwner: ownerGuid };
      delete nextProps.data;
      return { ...component, properties: nextProps };
    }
    const chunkId = typeof props.chunkId === "string" && isFoliageChunkId(props.chunkId) ? props.chunkId : null;
    const bytes = chunkId ? storedChunks?.get(chunkId) : undefined;
    if (!chunkId || !validChunk(bytes, props)) return component;
    chunks.set(chunkId, bytes);
    return { ...component, properties: { ...props, chunkOwner: ownerGuid } };
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

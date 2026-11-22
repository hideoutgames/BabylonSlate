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
import { bytesToBase64 } from "./chunk-base64";
import { mapPayloadComponents, sceneComponentChunkKey } from "./landscape-chunks";

export const FOLIAGE_CHUNK_KIND = "foliage";
export const FOLIAGE_CHUNK_MIME = "application/octet-stream";

/** A Scene component's chunk id: `foliage:<actorId>/<componentId>` (`sceneComponentChunkKey`). */
export function sceneFoliageChunkId(component: SerializedComponent, actor: SerializedActor | undefined): string {
  return foliageChunkId(sceneComponentChunkKey(component, actor));
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
 * that does not decode or does not match the component's batches is kept inline, never dropped
 * (`unreadableComponentChunks` names it).
 */
export function extractFoliageChunks<T>(payload: T): { payload: T; chunks: ChunkInput[] } {
  const chunks: ChunkInput[] = [];
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
    if (!bytes) return component;
    const chunkId = sceneFoliageChunkId(component, actor);
    chunks.push({ id: chunkId, kind: FOLIAGE_CHUNK_KIND, mime: FOLIAGE_CHUNK_MIME, data: bytes });
    const nextProps: Record<string, unknown> = { ...props, chunkId };
    delete nextProps.data;
    return { ...component, properties: nextProps };
  });
  return { payload: nextPayload, chunks };
}

/**
 * Restores `foliage:*` chunks into base64 `data` for editor documents (undo, journal, copy and paste). A component
 * whose chunk is missing, malformed or does not match its batches keeps its `chunkId`, so a later save carries the
 * stored chunk unchanged (`unreadableComponentChunks` names it).
 */
export function hydrateFoliageChunksToEditor<T>(
  payload: T,
  chunks: ReadonlyMap<string, Uint8Array>,
): T {
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
 * Prepares a Scene payload and its raw `HPFG` chunks for Play or export, so no base64 reaches the runtime: unsaved
 * editor `data` is decoded once into a chunk named by `chunkId`, and a stored `chunkId` reuses its bytes from
 * `storedChunks`. The runtime decodes them under the Scene the actor came from. Prefab and Class documents keep their
 * instances inline (`data`) and pass through.
 */
export function collectFoliageChunksForPlay<T>(
  payload: T,
  storedChunks?: ReadonlyMap<string, Uint8Array>,
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
      const nextProps: Record<string, unknown> = { ...props, chunkId };
      delete nextProps.data;
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

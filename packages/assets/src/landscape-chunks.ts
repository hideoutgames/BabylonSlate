import {
  decodeLandscapeBase64ToBytes,
  decodeLandscapeField,
  isLandscapeChunkId,
  landscapeChunkId,
  type SerializedActor,
  type SerializedComponent,
} from "@haptic/core";
import type { ChunkInput } from "./hasset";

export const LANDSCAPE_CHUNK_KIND = "landscape";
export const LANDSCAPE_CHUNK_MIME = "application/octet-stream";

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

type ComponentTransformer = (component: SerializedComponent) => SerializedComponent;

function mapPayloadComponents<T>(payload: T, transform: ComponentTransformer): T {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as {
    actors?: readonly SerializedActor[];
    components?: readonly SerializedComponent[];
  };
  let changed = false;

  let nextActors: SerializedActor[] | undefined;
  if (Array.isArray(record.actors)) {
    for (let ai = 0; ai < record.actors.length; ai++) {
      const actor = record.actors[ai]!;
      if (!Array.isArray(actor.components)) continue;
      let nextComponents: SerializedComponent[] | undefined;
      for (let ci = 0; ci < actor.components.length; ci++) {
        const component = actor.components[ci]!;
        const updated = transform(component);
        if (updated !== component) {
          const copy = nextComponents ?? actor.components.slice();
          copy[ci] = updated;
          nextComponents = copy;
        }
      }
      if (nextComponents) {
        const actorsCopy = nextActors ?? record.actors.slice();
        actorsCopy[ai] = { ...actor, components: nextComponents };
        nextActors = actorsCopy;
        changed = true;
      }
    }
  }

  let nextRootComponents: SerializedComponent[] | undefined;
  if (Array.isArray(record.components)) {
    for (let ci = 0; ci < record.components.length; ci++) {
      const component = record.components[ci]!;
      const updated = transform(component);
      if (updated !== component) {
        const copy = nextRootComponents ?? record.components.slice();
        copy[ci] = updated;
        nextRootComponents = copy;
        changed = true;
      }
    }
  }

  if (!changed) return payload;
  return {
    ...(payload as Record<string, unknown>),
    ...(nextActors ? { actors: nextActors } : {}),
    ...(nextRootComponents ? { components: nextRootComponents } : {}),
  } as T;
}

/** The raw `BSLD` bytes of a component's base64 `data`, or null when they are not a chunk its properties can read. */
function readableDataBytes(props: Record<string, unknown>, data: string): Uint8Array | null {
  const bytes = decodeLandscapeBase64ToBytes(data);
  return bytes && decodeLandscapeField({ ...props, data: undefined, chunkId: undefined }, bytes) ? bytes : null;
}

/**
 * Strips base64 `data` from every `LandscapeComponent` in a Scene payload and emits raw binary `BSLD` `.hasset`
 * chunks (`landscape:<componentId>`). Flat default terrains emit no binary chunk. Unreadable `data` is kept as it is,
 * so a save never replaces terrain it could not read with flat terrain. Prefab and Class payloads keep their terrain
 * inline: their components are copied into the Scenes that place them, which then own a chunk of their own.
 */
export function extractLandscapeChunks<T>(payload: T): { payload: T; chunks: ChunkInput[] } {
  const chunks: ChunkInput[] = [];
  const nextPayload = mapPayloadComponents(payload, (component) => {
    if (component.classId !== "LandscapeComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    const rawData = typeof props.data === "string" && props.data.length > 0 ? props.data : null;
    if (rawData) {
      const bytes = readableDataBytes(props, rawData);
      if (!bytes) return component;
      const chunkId = landscapeChunkId(component.id);
      chunks.push({
        id: chunkId,
        kind: LANDSCAPE_CHUNK_KIND,
        mime: LANDSCAPE_CHUNK_MIME,
        data: bytes,
      });
      const nextProps: Record<string, unknown> = { ...props, chunkId };
      delete nextProps.data;
      return { ...component, properties: nextProps };
    }
    if ("data" in props && props.data == null) {
      const nextProps: Record<string, unknown> = { ...props };
      delete nextProps.data;
      if (!nextProps.chunkId) delete nextProps.chunkId;
      return { ...component, properties: nextProps };
    }
    return component;
  });
  return { payload: nextPayload, chunks };
}

/**
 * Restores raw binary `landscape:*` `.hasset` chunks into JSON-safe base64 `data`
 * strings on `LandscapeComponent` properties for Editor `SerializedScene` editing,
 * undo/redo diffs, crash recovery, and copy/paste. A component whose chunk is missing
 * or unreadable keeps its `chunkId` (`unreadableLandscapes` names it), so saving
 * keeps the stored chunk instead of writing flat terrain over it.
 */
export function hydrateLandscapeChunksToEditor<T>(
  payload: T,
  chunks: ReadonlyMap<string, Uint8Array>,
): T {
  if (chunks.size === 0) return payload;
  return mapPayloadComponents(payload, (component) => {
    if (component.classId !== "LandscapeComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    const chunkId = typeof props.chunkId === "string" && isLandscapeChunkId(props.chunkId)
      ? props.chunkId
      : null;
    if (!chunkId) return component;
    const bytes = chunks.get(chunkId);
    if (!bytes || !decodeLandscapeField(props, bytes)) return component;
    const nextProps: Record<string, unknown> = {
      ...props,
      data: bytesToBase64(bytes),
    };
    delete nextProps.chunkId;
    return { ...component, properties: nextProps };
  });
}

/**
 * Prepares a Scene payload and its raw binary `BSLD` chunks for Play or Export with zero
 * base64 entering the runtime:
 * - Unsaved Editor `properties.data` is decoded once into raw `BSLD` bytes and replaced with `chunkId`.
 * - Disk-resident `properties.chunkId` entries reuse their raw `storedChunks` bytes directly.
 */
export function collectLandscapeChunksForPlay<T>(
  payload: T,
  storedChunks?: ReadonlyMap<string, Uint8Array>,
): { payload: T; chunks: Map<string, Uint8Array> } {
  const chunks = new Map<string, Uint8Array>();
  const nextPayload = mapPayloadComponents(payload, (component) => {
    if (component.classId !== "LandscapeComponent") return component;
    const props = component.properties;
    if (!props || typeof props !== "object") return component;
    const rawData = typeof props.data === "string" && props.data.length > 0 ? props.data : null;
    if (rawData) {
      const bytes = readableDataBytes(props, rawData);
      // Unreadable data keeps a chunk id with no bytes: the runtime reports it and plays it flat.
      const chunkId = landscapeChunkId(component.id);
      if (bytes) chunks.set(chunkId, bytes);
      const nextProps: Record<string, unknown> = { ...props, chunkId };
      delete nextProps.data;
      return { ...component, properties: nextProps };
    }
    const existingChunkId = typeof props.chunkId === "string" && isLandscapeChunkId(props.chunkId)
      ? props.chunkId
      : null;
    if (existingChunkId && storedChunks) {
      const bytes = storedChunks.get(existingChunkId);
      if (bytes && decodeLandscapeField(props, bytes)) {
        chunks.set(existingChunkId, bytes);
      }
    }
    return component;
  });
  return { payload: nextPayload, chunks };
}

/**
 * The Landscapes in a Scene, Prefab or Class payload whose terrain cannot be read (a missing or damaged chunk, or
 * damaged inline data), which show and play flat. Read after `hydrateLandscapeChunksToEditor`.
 */
export function unreadableLandscapes(payload: unknown): Array<{ actorName: string | null; componentId: string }> {
  const found: Array<{ actorName: string | null; componentId: string }> = [];
  const record = payload && typeof payload === "object"
    ? payload as { actors?: readonly SerializedActor[]; components?: readonly SerializedComponent[] }
    : {};
  const visit = (components: readonly SerializedComponent[] | undefined, actorName: string | null) => {
    if (!Array.isArray(components)) return;
    for (const component of components) {
      if (component?.classId !== "LandscapeComponent") continue;
      if (!decodeLandscapeField(component.properties)) found.push({ actorName, componentId: component.id });
    }
  };
  if (Array.isArray(record.actors)) for (const actor of record.actors) visit(actor.components, actor.name ?? null);
  visit(record.components, null);
  return found;
}

/** Lists all `landscape:*` chunk ids present in a `.hasset` chunk table. */
export function landscapeChunkIdsInHeader(
  chunks: ReadonlyArray<{ id: string }>,
): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    if (isLandscapeChunkId(chunk.id)) ids.push(chunk.id);
  }
  return ids;
}

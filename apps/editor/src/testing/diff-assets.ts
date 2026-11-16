import { encodeHasset } from "@haptic/assets";

/** An actor as a Scene document stores it. */
export function sceneActor(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    classId: "Actor",
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    components: [],
    folderId: null,
    ...extra,
  };
}

type Stored = { bytes: Uint8Array; blobs: Map<string, Uint8Array> };

/** A `.hasset` of `type` with `document` in its document chunk (or none), `payload` in its header and `chunks` beside it. */
export async function testAsset(type: string, name: string, options: { document?: unknown; payload?: Record<string, unknown>; chunks?: { id: string; kind: string; mime: string; data: Uint8Array }[] }): Promise<Stored> {
  const blobs = new Map<string, Uint8Array>();
  const bytes = await encodeHasset({
    header: {
      dependencies: [],
      requiredDependencies: [],
      ...(type === "Class" ? { requiredVariableNames: [] } : {}),
      dependencyMetadataVersion: 1,
      engineVersion: "0.0.0",
      guid: `guid-${name}`,
      mode: "thin",
      name,
      payload: options.payload ?? {},
      type,
      version: 1,
    },
    chunks: [
      ...(options.document === undefined ? [] : [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(options.document)) }]),
      ...(options.chunks ?? []),
    ],
    writeBlob: async (sha, data) => {
      blobs.set(sha, data);
    },
  });
  return { bytes, blobs };
}

/**
 * A Scene `.hasset` whose document holds `actors`, and the blobs it stores
 * chunks in (by digest): a document of 64 KiB or more is a blob, as a large
 * Scene's is.
 */
export function sceneAsset(actors: unknown[], name = "Forest"): Promise<Stored> {
  return testAsset("Scene", name, { document: { name, viewportMode: "3d", settings: {}, actors, folders: [] } });
}

/** `count` actors: enough for the document to go to a blob. */
export function manyActors(count: number, rename: Record<number, string> = {}) {
  return Array.from({ length: count }, (_, index) => sceneActor(`a${index}`, rename[index] ?? `Actor ${index}`));
}

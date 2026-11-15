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

/**
 * A Scene `.hasset` whose document holds `actors`, and the blobs it stores
 * chunks in (by digest): a document of 64 KiB or more is a blob, as a large
 * Scene's is.
 */
export async function sceneAsset(actors: unknown[], name = "Forest"): Promise<{ bytes: Uint8Array; blobs: Map<string, Uint8Array> }> {
  const blobs = new Map<string, Uint8Array>();
  const document = { name, viewportMode: "3d", settings: {}, actors, folders: [] };
  const bytes = await encodeHasset({
    header: {
      dependencies: [],
      requiredDependencies: [],
      dependencyMetadataVersion: 1,
      engineVersion: "0.0.0",
      guid: `guid-${name}`,
      mode: "thin",
      name,
      payload: {},
      type: "Scene",
      version: 4,
    },
    chunks: [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(document)) }],
    writeBlob: async (sha, data) => {
      blobs.set(sha, data);
    },
  });
  return { bytes, blobs };
}

/** `count` actors: enough for the document to go to a blob. */
export function manyActors(count: number, rename: Record<number, string> = {}) {
  return Array.from({ length: count }, (_, index) => sceneActor(`a${index}`, rename[index] ?? `Actor ${index}`));
}

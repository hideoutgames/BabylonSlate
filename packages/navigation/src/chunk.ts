export const NAVMESH_CHUNK_ID = "navmesh";

export type NavmeshChunk = {
  id: string;
  kind: "navmesh";
  mime: "application/octet-stream";
  data: Uint8Array;
};

export function navmeshChunk(bytes: Uint8Array): NavmeshChunk {
  return {
    id: NAVMESH_CHUNK_ID,
    kind: "navmesh",
    mime: "application/octet-stream",
    data: bytes,
  };
}

export function navmeshBytesFromChunks(
  chunks: Iterable<{ id: string; data?: Uint8Array }>,
): Uint8Array | null {
  for (const chunk of chunks) {
    if (chunk.id === NAVMESH_CHUNK_ID && chunk.data) return chunk.data;
  }
  return null;
}

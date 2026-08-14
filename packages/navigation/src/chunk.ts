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

export type ExtraChunkLike = {
  id: string;
  kind?: string;
  mime?: string;
  data?: Uint8Array;
};

/** Replace or insert the Scene `navmesh` extra chunk, keeping other extras. */
export function extraChunksWithNavmesh(
  extra: Iterable<ExtraChunkLike>,
  bytes: Uint8Array,
): Array<{ id: string; kind: string; mime: string; data: Uint8Array }> {
  const next: Array<{ id: string; kind: string; mime: string; data: Uint8Array }> =
    [];
  for (const chunk of extra) {
    if (chunk.id === NAVMESH_CHUNK_ID || !chunk.data) continue;
    next.push({
      id: chunk.id,
      kind: chunk.kind ?? "bin",
      mime: chunk.mime ?? "application/octet-stream",
      data: chunk.data,
    });
  }
  next.push(navmeshChunk(bytes));
  return next;
}

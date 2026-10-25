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

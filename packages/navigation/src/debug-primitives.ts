import { DebugDrawerUtils, Raw, importNavMesh, importTileCache } from "@recast-navigation/core";
import { unwrapTileCacheBytes, walkableTileCacheMeshProcess } from "./recast-backend";

/** Recast debug primitives for editor overlay (no Babylon). */
export function navMeshDebugPrimitives(bytes: Uint8Array) {
  const tileBytes = unwrapTileCacheBytes(bytes);
  const meshProcess = tileBytes ? walkableTileCacheMeshProcess() : null;
  let imported: ReturnType<typeof importNavMesh> | ReturnType<typeof importTileCache> | undefined;
  const drawer = new DebugDrawerUtils();
  try {
    imported = tileBytes && meshProcess ? importTileCache(tileBytes, meshProcess) : importNavMesh(bytes);
    return drawer.drawNavMesh(imported.navMesh);
  } finally {
    drawer.dispose();
    if (imported && "tileCache" in imported) {
      imported.tileCache.destroy();
      Raw.destroy(imported.allocator);
      Raw.destroy(imported.compressor);
    }
    imported?.navMesh.destroy();
    if (meshProcess) Raw.destroy(meshProcess.raw);
  }
}

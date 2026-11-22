import { DebugDrawerUtils, Raw } from "@recast-navigation/core";
import { destroyImportedNavMesh, importBakedNavMesh, unwrapTileCacheBytes, walkableTileCacheMeshProcess, type ImportedNavMesh } from "./recast-backend";

/** Recast debug primitives for editor overlay (no Babylon). */
export function navMeshDebugPrimitives(bytes: Uint8Array) {
  const tileBytes = unwrapTileCacheBytes(bytes);
  const meshProcess = tileBytes ? walkableTileCacheMeshProcess() : null;
  let imported: ImportedNavMesh | undefined;
  const drawer = new DebugDrawerUtils();
  try {
    imported = importBakedNavMesh(tileBytes ?? bytes, meshProcess);
    return drawer.drawNavMesh(imported.navMesh);
  } finally {
    drawer.dispose();
    if (imported) destroyImportedNavMesh(imported);
    if (meshProcess) Raw.destroy(meshProcess.raw);
  }
}

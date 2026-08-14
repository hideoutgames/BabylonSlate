import { DebugDrawerUtils, importNavMesh } from "@recast-navigation/core";

/** Recast debug primitives for editor overlay (no Babylon). */
export function navMeshDebugPrimitives(bytes: Uint8Array) {
  const imported = importNavMesh(bytes);
  const drawer = new DebugDrawerUtils();
  try {
    return drawer.drawNavMesh(imported.navMesh);
  } finally {
    drawer.dispose();
    imported.navMesh.destroy();
  }
}

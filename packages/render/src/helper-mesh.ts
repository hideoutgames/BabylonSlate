/** Editor grid plane and 2D camera frame; both follow the editor camera and never belong to the world. */
export const GRID_MESH_NAME = "__editor-grid__";
export const CAMERA_BOUNDS_MESH_NAME = "__editor-camera-bounds__";

/**
 * Metadata flags carried by editor and Play helper geometry: grids, gizmo-like visuals,
 * pick proxies, origins, debug overlays. Such meshes are never authored world content.
 */
const HELPER_METADATA_FLAGS = [
  "editorHelper",
  "editorActorOrigin",
  "editorPickProxy",
  "editorBillboard",
  "editorCameraModel",
  "editorVolume",
  "editorColliderVisual",
  "editorUnpickable",
  "editorModelPlaceholder",
  "playHelperVisual",
  "playActorOrigin",
  "playDebugOverlay",
] as const;

/** Debug overlays identified by name, including editor lines built before metadata tagging. */
const HELPER_NAME_PREFIXES = [
  "debugFrustum:",
  "debugLight:",
  "debugAudio:",
  "debugPreviewCam:",
  "debugCameraPreview:",
  "navmeshDebug",
  "playConsoleViz:",
  "playDebugDraw:",
] as const;

/** Tag an editor-owned helper so rendering systems that sample world content skip it. */
export function markEditorHelperMesh(mesh: { metadata: unknown }): void {
  mesh.metadata = { ...((mesh.metadata as Record<string, unknown> | null) ?? {}), editorHelper: true };
}

/**
 * The one predicate for editor/debug helper meshes. Water contacts, render-target captures,
 * viewport shading modes and shadow casting all use it, so a new helper only needs one tag.
 */
export function isEditorHelperMesh(mesh: { name: string; metadata: unknown }): boolean {
  const meta = mesh.metadata as Record<string, unknown> | null;
  if (meta && typeof meta === "object") {
    for (const flag of HELPER_METADATA_FLAGS) if (meta[flag]) return true;
  }
  if (mesh.name === GRID_MESH_NAME || mesh.name === CAMERA_BOUNDS_MESH_NAME) return true;
  return HELPER_NAME_PREFIXES.some((prefix) => mesh.name.startsWith(prefix));
}

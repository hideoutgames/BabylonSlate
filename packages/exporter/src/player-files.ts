/**
 * Drop editor-copy junk and physics engines the exported worlds do not use.
 * A 3D world keeps Rapier only when an exported Scene Layer enables physics,
 * since only those layers get a 2D world (engineplan §15.1).
 */
export function selectPlayerRuntimeFiles(
  files: ReadonlyMap<string, Uint8Array>,
  options: { physicsWorld: "2d" | "3d"; hasPhysicsSceneLayers?: boolean; includePreviewDiagnostics?: boolean },
): Map<string, Uint8Array> {
  const selected = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const relative = path.replace(/^\/+/, "");
    if (relative === "player-preview-diagnostics.js" && !options.includePreviewDiagnostics) continue;
    if (relative.endsWith("README.md") || relative.endsWith(".keep")) continue;
    if (
      options.physicsWorld === "3d" &&
      !options.hasPhysicsSceneLayers &&
      /rapier/i.test(relative)
    ) {
      continue;
    }
    if (options.physicsWorld === "2d" && /havok/i.test(relative)) continue;
    selected.set(relative, bytes);
  }
  return selected;
}

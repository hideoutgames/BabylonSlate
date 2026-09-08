/**
 * Drop editor-copy junk and physics engines the exported worlds do not use.
 * SceneLayers need Rapier alongside a 3D world's Havok (engineplan §15.1).
 */
export function selectPlayerRuntimeFiles(
  files: ReadonlyMap<string, Uint8Array>,
  options: { physicsWorld: "2d" | "3d"; hasSceneLayers?: boolean },
): Map<string, Uint8Array> {
  const selected = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const relative = path.replace(/^\/+/, "");
    if (relative.endsWith("README.md") || relative.endsWith(".keep")) continue;
    if (
      options.physicsWorld === "3d" &&
      !options.hasSceneLayers &&
      /rapier/i.test(relative)
    ) {
      continue;
    }
    if (options.physicsWorld === "2d" && /havok/i.test(relative)) continue;
    selected.set(relative, bytes);
  }
  return selected;
}

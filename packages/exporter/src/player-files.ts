import { evaluatePlatformCondition, platformSymbols, type BuildPlatform } from "@haptic/core";

/** The player build's list of platform module files and their conditions (`apps/player/vite-platform-modules.ts`). */
export const PLATFORM_MODULES_FILE = "platform-modules.json";

/** Files of platform modules mapped to their conditions; empty without a list. */
function platformModuleConditions(files: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const bytes = files.get(PLATFORM_MODULES_FILE) ?? files.get(`/${PLATFORM_MODULES_FILE}`);
  if (!bytes) return new Map();
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${PLATFORM_MODULES_FILE} is not an object.`);
  return new Map(Object.entries(parsed).map(([file, condition]) => {
    if (typeof condition !== "string") throw new Error(`${PLATFORM_MODULES_FILE} gives ${file} no condition.`);
    return [file, condition];
  }));
}

/**
 * Drop editor-copy junk, physics engines the exported worlds do not use and the player's platform modules for other
 * platforms. A 3D world keeps Rapier only when an exported Scene Layer enables physics, since only those layers get a
 * 2D world (engineplan §15.1).
 */
export function selectPlayerRuntimeFiles(
  files: ReadonlyMap<string, Uint8Array>,
  options: { physicsWorld: "2d" | "3d"; platform: BuildPlatform; hasPhysicsSceneLayers?: boolean; includePreviewDiagnostics?: boolean },
): Map<string, Uint8Array> {
  const symbols = platformSymbols(options.platform, { editor: false });
  const platformModules = platformModuleConditions(files);
  const selected = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const relative = path.replace(/^\/+/, "");
    if (relative === PLATFORM_MODULES_FILE) continue;
    const condition = platformModules.get(relative);
    if (condition !== undefined && !evaluatePlatformCondition(condition, symbols)) continue;
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

import type { ScriptBundleEntry } from "@haptic/bridge";
import type { GameManifest } from "@haptic/exporter";
import type { LoadedGame } from "./artifact";

/** Every exported console command, including those of Classes the game has not loaded yet. */
export function manifestConsoleCommands(manifest: GameManifest, scripts: readonly ScriptBundleEntry[]) {
  return manifest.assets.flatMap(entry => {
    if (!entry.consoleCommand) return [];
    const classId = entry.classId ?? scripts.find(script => script.assetGuid === entry.guid)?.classId ?? entry.name ?? entry.guid;
    return [{ ...entry.consoleCommand, name: entry.consoleCommand.name || classId.toLowerCase(), classId, assetGuid: entry.guid }];
  });
}

/** The Preview console's command list and Scene completions cover the whole build, not only what startup loaded. */
export function previewConsoleCatalog(game: Pick<LoadedGame, "manifest" | "scripts" | "scenes">) {
  const scenes = new Set<string>();
  for (const entry of game.manifest.assets) if (entry.type === "Scene") {
    scenes.add(entry.guid);
    if (entry.name) scenes.add(entry.name);
  }
  // A loaded Scene's own name opens it as well.
  for (const scene of game.scenes.values()) if (scene.name) scenes.add(scene.name);
  return {
    commands: manifestConsoleCommands(game.manifest, game.scripts).map(({ name, description, category, parameters }) => ({ name, description, category, parameters })),
    scenes: [...scenes],
  };
}

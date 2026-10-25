import { describe, expect, it } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { exportGame } from "@haptic/exporter";
import { loadGameFromFiles } from "./artifact";
import { previewConsoleCatalog } from "./console-catalog";

const encoder = new TextEncoder();

describe("previewConsoleCatalog", () => {
  it("lists the commands and Scenes of the whole build, not only those startup loaded", async () => {
    const command = { name: "god", description: "Toggle invulnerability", category: "Cheats", parameters: [] };
    const exported = await exportGame({ bundleDebugger: true, startupSceneGuid: "world", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [{ assetGuid: "cheat", classId: "Cheat", source: "export function onCommandRun() {}", anchors: [], entryPoints: [], command }],
      assets: [
        { guid: "world", type: "Scene", name: "World", sceneGuid: "world", bytes: encoder.encode(JSON.stringify({ ...createDefaultScene(), name: "Overworld" })) },
        { guid: "arena", type: "Scene", name: "Arena", sceneGuid: "arena", bytes: encoder.encode(JSON.stringify(createDefaultScene())) },
        { guid: "cheat", type: "Class", sceneGuid: "world", bytes: encoder.encode("{}") },
      ] });
    if (!exported.ok) throw new Error(exported.error);
    const game = await loadGameFromFiles(exported.value.files);
    try {
      const catalog = previewConsoleCatalog(game);
      expect(catalog.commands).toEqual([command]);
      expect(catalog.scenes).toEqual(expect.arrayContaining(["world", "World", "Overworld", "arena", "Arena"]));
    } finally { game.dispose!(); }
  });
});

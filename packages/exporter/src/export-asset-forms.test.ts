import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { exportGame } from "./export-game";
import { stripEditorOnlyFields } from "./export-asset-forms";

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

describe("stripEditorOnlyFields", () => {
  it("drops a Scene's outliner, prefab bookkeeping, viewport settings and raw script, and keeps what the game reads", () => {
    const scene = {
      version: 3,
      script: { nodes: [{ id: "n" }] },
      folders: [{ id: "f", name: "Props" }],
      settings: { gravity: [0, -9.8, 0], grid: { tileSize: 1 }, editorJoystickEnabled: true, showNavmesh: false, foliageGroups: [{ id: "g", models: [] }] },
      actors: [{
        id: "a", folderId: "f", prefabGuid: "p", locked: true, suppressedComponentSourceIds: ["s"],
        components: [{ id: "c", classId: "MeshComponent", sourceId: "s2", overrideKeys: ["meshKind"], properties: { assetGuid: "m" } }],
      }],
    };
    expect(stripEditorOnlyFields("Scene", scene)).toEqual({
      version: 3,
      settings: { gravity: [0, -9.8, 0], foliageGroups: [{ id: "g", models: [] }] },
      actors: [{
        id: "a", locked: true, suppressedComponentSourceIds: ["s"],
        components: [{ id: "c", classId: "MeshComponent", sourceId: "s2", properties: { assetGuid: "m" } }],
      }],
    });
  });

  it.each([
    ["Material", { preview: { mesh: "sphere" }, description: "Rock", nodes: [] }, { nodes: [] }],
    ["MaterialInstance", { preview: { mesh: "cube" }, description: "", parent: "m" }, { parent: "m" }],
    ["AnimationGraph3D", { previewModelGuid: "hero", stateMachine: {} }, { stateMachine: {} }],
    ["ParticleSystem", { previewSkybox: false, emitterGuids: ["e"] }, { emitterGuids: ["e"] }],
    ["Tilemap", { preview: "kept: no rule for this type" }, { preview: "kept: no rule for this type" }],
  ])("strips a %s's preview and description fields only", (type, document, expected) => {
    expect(stripEditorOnlyFields(type, document)).toEqual(expected);
  });
});

describe("exported asset forms", () => {
  async function exported() {
    const result = await exportGame({
      platform: "web", bundleDebugger: false, startupSceneGuid: "scene", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [{ assetGuid: "hero-class", classId: "Hero", source: "", anchors: [], entryPoints: [] }],
      assets: [
        { guid: "scene", type: "Scene", sceneGuid: "scene", bytes: json({ actors: [], folders: [] }), requiredDependencies: ["hero-class", "walk", "settings"] },
        { guid: "hero-class", type: "Class", sceneGuid: "scene", bytes: json({ nodes: [{ id: "event-tick" }], members: [] }), requiredDependencies: [] },
        { guid: "walk", type: "BlendSpace", sceneGuid: "scene", bytes: json({ samples: [] }), requiredDependencies: [] },
        { guid: "jump", type: "InputAction", sceneGuid: "scene", bytes: json({ name: "Jump" }), requiredDependencies: [] },
        { guid: "settings", type: "PluginSettings", sceneGuid: "scene", bytes: json({}), requiredDependencies: [] },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  it("parses every runtime JSON type as JSON", async () => {
    // A Blend Space is a JSON document the player decodes: shipping it as bytes made it parse again on every hydration.
    expect((await exported()).manifest.assets.find((entry) => entry.guid === "walk")?.encoding).toBe("json");
  });

  it("keeps catalog-only types as entries with no file and drops omitted types with their edges", async () => {
    const artifact = await exported();
    const entry = (guid: string) => artifact.manifest.assets.find((asset) => asset.guid === guid);
    for (const guid of ["hero-class", "jump"]) {
      expect(entry(guid)).toMatchObject({ byteLength: 0 });
      expect(entry(guid)?.path).toBeUndefined();
    }
    // The Class runs from its compiled script sidecar, which still ships and loads with it.
    const script = artifact.manifest.assets.find((asset) => asset.type === "CompiledScript")!;
    expect(entry("hero-class")?.requiredDependencies).toContain(script.guid);
    expect(artifact.files.has(script.path!)).toBe(true);
    expect(entry("settings")).toBeUndefined();
    expect(entry("scene")?.requiredDependencies).toEqual(["hero-class", "walk"]);
    const scene = JSON.parse(new TextDecoder().decode(artifact.files.get(entry("scene")!.path!))) as Record<string, unknown>;
    expect(scene).not.toHaveProperty("folders");
  });
});

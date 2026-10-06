import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createText3DComponent,
  createText2DComponent,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  defaultExportPreset,
  normalizeFocusNavigationSettings,
  isErr,
  isOk,
  type SerializedGraph,
} from "@babylonslate/core";
import { migrateLegacyShaderPayload } from "@babylonslate/shader-graph";
import { createDefaultPluginSettings } from "@babylonslate/assets";
import {
  MISSING_STARTUP_SCENE_MESSAGE,
  parseScriptRegistry,
} from "@babylonslate/exporter";
import { collectAndExportGame, resolveExportPluginGraph } from "./export-game";
import type { ExportIndexedAsset, ExportArtifact } from "@babylonslate/exporter";
// Collect the real compiler with the suite so cold transforms are not timed as export work.
import "./script-compiler";

function compiledScripts(artifact: ExportArtifact): ReturnType<typeof parseScriptRegistry> {
  return artifact.manifest.assets.filter(asset => asset.type === "CompiledScript").map(asset =>
    JSON.parse(new TextDecoder().decode(artifact.files.get(asset.path!))));
}

function asset(
  partial: Partial<ExportIndexedAsset> &
    Pick<ExportIndexedAsset, "guid" | "type" | "name">,
): ExportIndexedAsset {
  return {
    dependencies: [],
    rootId: "project",
    parentClass: null,
    ...partial,
  };
}

const playerFiles = new Map([
  ["index.html", new TextEncoder().encode("<html></html>")],
  ["player.js", new TextEncoder().encode("void 0")],
]);

describe("collectAndExportGame", () => {
  it.each([true, false])("retains project focus navigation in editor exports with preview=%s", async (previewBuild) => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene", assets: [asset({ guid: "scene", type: "Scene", name: "Main" })],
      plugins: [], projectPluginOverrides: {}, parentOf: () => null,
      sceneByGuid: () => scene, graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, playFrameCap: 60, physicsWorld: "3d", playerFiles, previewBuild,
      focusNavigation: normalizeFocusNavigationSettings({ enabled: false, navigationInputGuid: "menu-axis", activateInputGuid: "accept", repeatDelay: 0.7, wrap: true }),
    });
    if (!isOk(result)) throw new Error(result.error);
    expect(result.value.manifest.focusNavigation).toMatchObject({ enabled: false, navigationInputGuid: "menu-axis", activateInputGuid: "accept", repeatDelay: 0.7, wrap: true });
  });

  it("resolves plugins with version warnings while still rejecting missing dependencies", () => {
    const plugin = { pluginGuid: "pack", settings: createDefaultPluginSettings({ pluginGuid: "pack", displayName: "Pack" }) };
    plugin.settings.engineVersion = "";
    const overrides = { pack: { enabled: true } };
    const preset = defaultExportPreset();
    preset.pluginOverrides = { pack: { enabled: true } };
    expect(resolveExportPluginGraph([plugin], overrides, preset).order).toEqual([plugin]);
    expect(resolveExportPluginGraph([plugin], overrides, preset).diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("engine Unknown") }),
    ]);
    plugin.settings.pluginDependencies = [{ guid: "missing", version: "0.1" }];
    expect(resolveExportPluginGraph([plugin], overrides, preset).order).toEqual([]);
    expect(resolveExportPluginGraph([plugin], overrides, preset).diagnostics).toContainEqual(expect.objectContaining({ code: "plugin.missing", severity: "error" }));
  });

  it.each(["Class variable", "Spawn Actor dropdown"])("packs the inherited prefab referenced only by a %s", async (source) => {
    const mesh = createMeshComponent("parent-mesh", "box");
    const childCollider = {
      id: "child-collider",
      classId: "ColliderComponent",
      parentId: mesh.id,
      properties: {},
    };
    const graphs: Record<string, SerializedGraph> = {
      "class-main": {
        nodes: [
          ...(source === "Spawn Actor dropdown" ? [
            { id: "spawn", type: "actor.spawn", position: { x: 0, y: 0 }, data: { "default:classId": "SpawnChild" } },
          ] : []),
          { id: "print", type: "debug.print", position: { x: 0, y: 100 }, data: { "default:value": "Unused" } },
        ],
        edges: [],
        members: source === "Class variable"
          ? [{ id: "spawn", kind: "variable", name: "SpawnClass", typeId: "class", typeClassId: "SpawnChild", defaultValue: "SpawnChild" }]
          : [],
      },
      "class-base": { nodes: [], edges: [], components: [mesh] },
      "class-child": { nodes: [], edges: [], components: [childCollider] },
    };
    const scene = {
      ...createDefaultScene(),
      actors: [createActor("spawner", "Spawner", { classId: "main" })],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-main",
      assets: [
        asset({ guid: "scene-main", type: "Scene", name: "Main" }),
        asset({ guid: "class-main", type: "Class", name: "main", parentClass: "Actor" }),
        asset({ guid: "class-base", type: "Class", name: "SpawnBase", parentClass: "Actor" }),
        asset({ guid: "class-child", type: "Class", name: "SpawnChild", parentClass: "SpawnBase" }),
        asset({ guid: "class-unused", type: "Class", name: "Unused", parentClass: "Actor" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: (id) => id === "SpawnChild" ? "SpawnBase" : "Actor",
      sceneByGuid: (guid) => guid === "scene-main" ? scene : null,
      graphByGuid: (guid) => graphs[guid] ?? null,
      bytesByGuid: (guid) => new TextEncoder().encode(JSON.stringify(guid === "scene-main" ? scene : graphs[guid] ?? {})),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
      previewBuild: true,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const scripts = compiledScripts(result.value);
    expect(scripts.map((script) => script.classId).sort()).toEqual(["SpawnBase", "SpawnChild", "main"]);
    expect(scripts.find(script => script.classId === "SpawnChild")?.assetGuid).toBe("class-child");
    const childSource = result.value.manifest.assets.find(asset => asset.type === "CompiledScript" && asset.ownerGuid === "class-child")!;
    expect(result.value.manifest.assets.find(asset => asset.guid === "class-child")?.requiredDependencies).toContain(childSource.guid);
    expect(scripts.find((script) => script.classId === "SpawnChild")?.components).toEqual([
      { ...mesh, inheritedFrom: "SpawnBase" },
      childCollider,
    ]);
  });

  it("ships empty subsystem classes no scene references, with their empty user bases", async () => {
    const empty: SerializedGraph = { nodes: [], edges: [] };
    const parents: Record<string, string> = {
      Save: "GameSubsystem",
      Weather: "SceneSubsystem",
      RainWeather: "Weather",
      Unused: "Actor",
    };
    const classAsset = (name: string) =>
      asset({ guid: `class-${name}`, type: "Class", name, parentClass: parents[name] ?? null });
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-main",
      assets: [
        asset({ guid: "scene-main", type: "Scene", name: "Main" }),
        ...Object.keys(parents).map(classAsset),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: (id) => parents[id] ?? null,
      sceneByGuid: (guid) => (guid === "scene-main" ? scene : null),
      graphByGuid: (guid) => (guid.startsWith("class-") ? empty : null),
      bytesByGuid: (guid) => new TextEncoder().encode(JSON.stringify(guid === "scene-main" ? scene : empty)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const scripts = compiledScripts(result.value);
    expect(
      scripts.map((script) => [script.classId, script.parentClassId]).sort(),
    ).toEqual([
      ["RainWeather", "Weather"],
      ["Save", "GameSubsystem"],
      ["Weather", "SceneSubsystem"],
    ]);
  });

  it("exports startup reachability through stable independent paths without duplicating shared assets", async () => {
    const start = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        environmentTextureGuid: "boot-only",
        sceneLayers: [
          { assetGuid: "scene-z", zOrder: 0, enabled: true },
          { assetGuid: "scene-a", zOrder: 1, enabled: true },
        ],
      },
    };
    const secondary = createDefaultScene();
    const assets = [
      asset({ guid: "scene-start", type: "Scene", name: "Start" }),
      asset({
        guid: "scene-z",
        type: "Scene",
        name: "Zed",
        dependencies: ["shared"],
      }),
      asset({
        guid: "scene-a",
        type: "Scene",
        name: "Alpha",
        dependencies: ["shared"],
      }),
      asset({ guid: "boot-only", type: "Texture", name: "Boot" }),
      asset({ guid: "shared", type: "Texture", name: "Shared" }),
    ];
    const run = (registry: ExportIndexedAsset[]) =>
      collectAndExportGame({
        startupSceneGuid: "scene-start",
        assets: registry,
        plugins: [],
        projectPluginOverrides: {},
        parentOf: () => null,
        sceneByGuid: (guid) => (guid === "scene-start" ? start : secondary),
        graphByGuid: () => null,
        bytesByGuid: (guid) => new TextEncoder().encode(guid),
        renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
        playFrameCap: 60,
        physicsWorld: "3d",
        playerFiles,
      });
    const first = await run(assets);
    const reversed = await run([...assets].reverse());
    expect(first.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (!isOk(first) || !isOk(reversed)) return;
    const paths = (result: typeof first.value) =>
      Object.fromEntries(
        result.manifest.assets.map((entry) => [entry.guid, entry.path]),
      );
    expect(paths(first.value)).toEqual(paths(reversed.value));
    expect(Object.keys(paths(first.value)).sort()).toEqual(["boot-only", "scene-a", "scene-start", "scene-z", "shared"]);
    expect(new Set(Object.values(paths(first.value))).size).toBe(5);
    expect(first.value.manifest.packs).toEqual([]);
    for (const entry of first.value.manifest.assets) {
      expect(entry.pack).toBeUndefined();
      expect(entry.path).toMatch(/^assets\/data-\d+\.bin$/);
      expect(new TextDecoder().decode(first.value.files.get(entry.path!))).toBe(entry.guid);
    }
    for (const sceneGuid of ["scene-a", "scene-z"]) {
      expect(first.value.manifest.assets.find(entry => entry.guid === sceneGuid)?.dependencies).toContain("shared");
    }
  });

  it("fails with the startup scene copy when the guid is missing", async () => {
    const result = await collectAndExportGame({
      startupSceneGuid: null,
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => null,
      graphByGuid: () => null,
      bytesByGuid: () => null,
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(false);
    if (isErr(result)) {
      expect(result.error).toBe(MISSING_STARTUP_SCENE_MESSAGE);
    }
  });

  it("packs the startup scene guid and strips editor-only classes", async () => {
    const scene = {
      ...createDefaultScene(),
      settings: {
        ...createDefaultScene().settings,
        gameInstanceClass: "MyGame",
      },
      actors: [createActor("hero", "Hero", { classId: "Hero" })],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-game",
          type: "Class",
          name: "MyGame",
          parentClass: "GameInstance",
        }),
        asset({
          guid: "euo-1",
          type: "Class",
          name: "Tools",
          parentClass: "EditorUtilityObject",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      parentOf: (id) => {
        if (id === "MyGame") return "GameInstance";
        if (id === "Tools" || id === "EditorUtilityObject") return "BObject";
        return null;
      },
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode("{}"),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.startupSceneGuid).toBe("scene-1");
    expect(result.value.manifest.mode).toBe("packed");
    expect(result.value.manifest.bundleDebugger).toBe(false);
    const startupAsset = result.value.manifest.assets.find(entry => entry.guid === "scene-1")!;
    expect(startupAsset.path).toMatch(/^assets\/data-\d+\.bin$/);
    expect(new TextDecoder().decode(result.value.files.get(startupAsset.path!))).toBe(JSON.stringify(scene));
    expect(result.value.manifest.packs).toEqual([]);
    expect(
      result.value.manifest.assets.some((entry) => entry.guid === "euo-1"),
    ).toBe(false);
  });

  it("warns when a packed Material samples a Texture that has no bytes", async () => {
    const mesh = createMeshComponent("mesh-1", "box");
    mesh.properties.materialGuid = "mat-rock";
    const scene = {
      ...createDefaultScene(),
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    };
    const material = migrateLegacyShaderPayload(
      {},
      { textureGuids: ["tex-missing"] },
    );
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "mat-rock", type: "Material", name: "Rock" }),
        asset({ guid: "tex-missing", type: "Texture", name: "Missing" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
      payloadByGuid: (guid) => (guid === "mat-rock" ? material : null),
      bytesByGuid: (guid) => {
        if (guid === "scene-1")
          return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "mat-rock")
          return new TextEncoder().encode(JSON.stringify(material));
        return null;
      },
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.warnings.some((warning) => warning.includes("tex-missing")),
    ).toBe(true);
  });

  it("packs a live render texture and its target without a missing-pixels warning", async () => {
    const mesh = createMeshComponent("mesh", "box");
    mesh.properties.materialGuid = "material";
    const scene = { ...createDefaultScene(), actors: [createActor("screen", "Screen", { components: [mesh] })] };
    const material = migrateLegacyShaderPayload({}, { textureGuids: ["live-texture"] });
    const payloads: Record<string, unknown> = { scene, material, "live-texture": { renderTargetGuid: "target" }, target: { mode: "DepthPass", width: 128, height: 128 } };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene",
      assets: [asset({ guid: "scene", type: "Scene", name: "Main" }), asset({ guid: "material", type: "Material", name: "Screen" }), asset({ guid: "live-texture", type: "RenderTargetTexture", name: "Depth" }), asset({ guid: "target", type: "RenderTarget", name: "Capture" })],
      plugins: [], projectPluginOverrides: {}, parentOf: () => null, sceneByGuid: (guid) => guid === "scene" ? scene : null, graphByGuid: () => null,
      payloadByGuid: (guid) => payloads[guid] ?? null,
      bytesByGuid: (guid) => payloads[guid] ? new TextEncoder().encode(JSON.stringify(payloads[guid])) : null,
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, playFrameCap: 60, physicsWorld: "3d", playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.assets.map((entry) => entry.guid)).toEqual(expect.arrayContaining(["target", "live-texture"]));
    expect(result.value.warnings.some((warning) => warning.includes("live-texture"))).toBe(false);
  });

  it("packs a project Game Instance when the startup scene omits one", async () => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      gameInstanceClass: "MyGame",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({
          guid: "class-game",
          type: "Class",
          name: "MyGame",
          parentClass: "GameInstance",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      parentOf: (id) => (id === "MyGame" ? "GameInstance" : null),
      sceneByGuid: (guid) => (guid === "scene-1" ? scene : null),
      graphByGuid: () => null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode("{}"),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.gameInstanceClass).toBe("MyGame");
    expect(
      result.value.manifest.assets.some((entry) => entry.guid === "class-game"),
    ).toBe(true);
  });

  it("packs a sprite textureGuid reached through the sprite payload", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "sprite-comp",
              classId: "SpriteComponent",
              properties: { assetGuid: "sprite-1" },
            },
          ],
        }),
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "sprite-1", type: "Sprite", name: "Hero" }),
        asset({ guid: "tex-atlas", type: "Texture", name: "Atlas" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) =>
        guid === "sprite-1" ? { textureGuid: "tex-atlas" } : null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode(guid),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const guids = result.value.manifest.assets.map((entry) => entry.guid);
    expect(guids).toEqual(
      expect.arrayContaining(["scene-1", "sprite-1", "tex-atlas"]),
    );
  });

  it("reports Compiling then Writing Pack", async () => {
    const scene = createDefaultScene();
    const phases: string[] = [];
    await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(["Compiling", "Writing Pack"]);
  });

  it.each([false, true])(
    "export-preset layer 3 sets plugin enablement to %s despite recorded version warnings",
    async (enabled) => {
      const scene = {
        ...createDefaultScene(),
        actors: [createActor("a", "Starter", { classId: "StarterActor" })],
      };
      const result = await collectAndExportGame({
        startupSceneGuid: "scene-1",
        assets: [
          asset({ guid: "scene-1", type: "Scene", name: "Main" }),
          asset({
            guid: "plug-class",
            type: "Class",
            name: "StarterActor",
            parentClass: "Actor",
            rootId: "plugin:plug-1",
          }),
        ],
        plugins: [
          {
            pluginGuid: "plug-1",
            settings: {
              ...createDefaultPluginSettings({
                pluginGuid: "plug-1",
                displayName: "Starter",
              }),
              enabledByDefault: !enabled,
              engineVersion: "",
            },
          },
        ],
        projectPluginOverrides: { "plug-1": { enabled: !enabled } },
        preset: {
          ...defaultExportPreset(),
          pluginOverrides: { "plug-1": { enabled } },
        },
        parentOf: () => "Actor",
        sceneByGuid: () => scene,
        graphByGuid: () => null,
        bytesByGuid: (guid) =>
          guid === "scene-1"
            ? new TextEncoder().encode(JSON.stringify(scene))
            : new TextEncoder().encode("{}"),
        renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
        playFrameCap: 60,
        physicsWorld: "3d",
        playerFiles,
      });
      expect(result.ok).toBe(true);
      if (!isOk(result)) return;
      expect(
        result.value.manifest.assets.some(
          (entry) => entry.guid === "plug-class",
        ),
      ).toBe(enabled);
      expect(result.value.warnings.some((warning) => warning.includes('"Starter" was created with engine Unknown'))).toBe(enabled);
    },
  );

  it("rejects an export preset that disables an enabled plugin's required dependency", async () => {
    const dependent = createDefaultPluginSettings({
      pluginGuid: "dependent",
      displayName: "Gameplay Tools",
    });
    const dependency = createDefaultPluginSettings({
      pluginGuid: "dependency",
      displayName: "Shared Content",
    });
    dependent.enabledByDefault = true;
    dependency.enabledByDefault = true;
    dependent.pluginDependencies = [
      { guid: "dependency", version: "1.0.0" },
    ];
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [
        { pluginGuid: "dependent", settings: dependent },
        { pluginGuid: "dependency", settings: dependency },
      ],
      projectPluginOverrides: {},
      preset: {
        ...defaultExportPreset(),
        pluginOverrides: { dependency: { enabled: false } },
      },
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result).toEqual({
      ok: false,
      error:
        'Enable or install "Shared Content", required by "Gameplay Tools", or disable "Gameplay Tools" in the export preset.',
    });
  });

  it.each([false, true])("compiles class and AnimationGraph scripts with project Tags for preview=%s", async (previewBuild) => {
    const tagGraph: SerializedGraph = {
      nodes: [
        { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} },
        { id: "name", type: "tags.toString", position: { x: 0, y: 100 }, data: { "default:value": 2 } },
        { id: "log", type: "debug.log", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [
        { id: "start", source: "begin", sourceHandle: "execOut", target: "log", targetHandle: "execIn" },
        { id: "name", source: "name", sourceHandle: "out", target: "log", targetHandle: "message" },
      ],
    };
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          classId: "TagActor",
          components: [
            {
              id: "anim",
              classId: "AnimationGraphComponent",
              properties: { graphGuid: "graph-1" },
            },
          ],
        }),
      ],
    };
    const doc = createDefaultAnimGraph();
    doc.transitions.push({
      id: "idle-to-idle",
      fromStateId: "idle",
      toStateId: "idle",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: {
        nodes: [
          {
            id: "enter-state",
            type: "anim.rule.enterState",
            position: { x: 0, y: 0 },
            data: { __protected: true },
          },
          {
            id: "exit-state",
            type: "anim.rule.exitState",
            position: { x: 0, y: 80 },
            data: { __protected: true },
          },
          {
            id: "tag-match",
            type: "tags.matches",
            position: { x: -200, y: 0 },
            data: { "default:value": 2, "default:query": 1 },
          },
        ],
        edges: [{ id: "tag-enter", source: "tag-match", sourceHandle: "out", target: "enter-state", targetHandle: "value" }],
      },
    });
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "class-1", type: "Class", name: "TagActor", parentClass: "Actor" }),
        asset({
          guid: "graph-1",
          type: "AnimationGraph",
          name: "Loco",
          path: "assets/Loco.anim.babasset",
        }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: (guid) => guid === "class-1" ? tagGraph : null,
      payloadByGuid: (guid) => (guid === "graph-1" ? doc : null),
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new TextEncoder().encode(JSON.stringify(guid === "class-1" ? tagGraph : doc)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
      previewBuild,
      tagRegistry: {
        tags: [
          { id: 1, path: "State", parentId: 0 },
          { id: 2, path: "State.Ready", parentId: 1 },
        ],
        nextId: 3,
      },
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    const registry = compiledScripts(result.value);
    const scripts = registry.map(script => script.source).join("\n");
    expect(registry.map((entry) => entry.classId)).toEqual(
      expect.arrayContaining([
        "AnimGraph:graph-1",
        "AnimRule:graph-1:idle-to-idle",
      ]),
    );
    expect(scripts).toContain("onInitializeAnimation");
    expect(scripts).toContain("export function evaluate(ctx)");
    const actor = registry.find((entry) => entry.classId === "TagActor");
    const rule = registry.find((entry) => entry.classId === "AnimRule:graph-1:idle-to-idle");
    const graphSources = result.value.manifest.assets.filter(asset => asset.type === "CompiledScript" && asset.ownerGuid === "graph-1");
    expect(graphSources).toHaveLength(2);
    expect(new Set(graphSources.map(asset => asset.guid)).size).toBe(2);
    expect(result.value.manifest.assets.find(asset => asset.guid === "graph-1")?.requiredDependencies).toEqual(expect.arrayContaining(graphSources.map(asset => asset.guid)));
    expect(rule?.assetGuid).toBe("graph-1");
    expect(actor).toBeDefined();
    expect(rule).toBeDefined();
    const begin = new Function(
      `${actor!.source.replace(/export function /g, "function ")}\nreturn onBeginPlay;`,
    )() as (ctx: unknown) => void;
    const logs: string[] = [];
    begin({
      checkInfiniteLoop: () => {},
      formatValue: String,
      log: (_severity: string, _category: string, value: string) => logs.push(value),
    });
    expect(logs).toEqual(["State.Ready"]);
    const evaluate = new Function(
      `${rule!.source.replace(/export function /g, "function ")}\nreturn evaluate;`,
    )() as (ctx: unknown) => { enter: boolean };
    expect(evaluate({}).enter).toBe(true);
  });

  it("packs a scene navmesh chunk under a sidecar guid", async () => {
    const scene = createDefaultScene();
    const nav = new Uint8Array([9, 8, 7]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      navmeshByGuid: (guid) => (guid === "scene-1" ? nav : null),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "NavMesh" && entry.guid === "navmesh:scene-1",
      ),
    ).toBe(true);
  });

  it("packs Texture KTX2 GPU bytes", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [
            {
              id: "mesh-1",
              classId: "MeshComponent",
              properties: { textureGuid: "tex-1" },
            },
          ],
        }),
      ],
    };
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "tex-1", type: "Texture", name: "Logo" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1")
          return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "tex-1") return ktx2;
        return null;
      },
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "Texture" && entry.guid === "tex-1",
      ),
    ).toBe(true);
  });

  it("packs a scene audioReverb chunk under a sidecar guid", async () => {
    const scene = createDefaultScene();
    const field = new Uint8Array([3, 2, 1]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      audioReverbByGuid: (guid) => (guid === "scene-1" ? field : null),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "AudioReverb" && entry.guid === "audioReverb:scene-1",
      ),
    ).toBe(true);
  });

  it("packs Font facetype JSON as a FontFacetype sidecar alongside Font source bytes", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "3D Text", {
          components: [
            {
              ...createText3DComponent("text-1"),
              properties: {
                ...createText3DComponent("text-1").properties,
                fontAssetGuid: "font-1",
              },
            },
          ],
        }),
      ],
    };
    const source = new Uint8Array([1, 2, 3]);
    const facetype = new Uint8Array([9, 8, 7]);
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Display" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1")
          return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "font-1") return source;
        return null;
      },
      fontFacetypeBytesByGuid: (guid) => (guid === "font-1" ? facetype : null),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) => entry.type === "Font" && entry.guid === "font-1",
      ),
    ).toBe(true);
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "FontFacetype" &&
          entry.guid === "font-facetype:font-1",
      ),
    ).toBe(true);
  });

  it("packs Font MSDF JSON and atlas PNG as FontMsdf sidecars", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "2D Text", {
          components: [
            {
              ...createText2DComponent("text-1"),
              properties: {
                ...createText2DComponent("text-1").properties,
                fontAssetGuid: "font-1",
              },
            },
          ],
        }),
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Display" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: (guid) => {
        if (guid === "scene-1")
          return new TextEncoder().encode(JSON.stringify(scene));
        if (guid === "font-1") return new Uint8Array([1, 2]);
        return null;
      },
      fontMsdfJsonByGuid: (guid) =>
        guid === "font-1" ? new Uint8Array([9]) : null,
      fontMsdfPngByGuid: (guid) =>
        guid === "font-1" ? new Uint8Array([8]) : null,
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "FontMsdf" && entry.guid === "font-msdf:font-1",
      ),
    ).toBe(true);
    expect(
      result.value.manifest.assets.some(
        (entry) =>
          entry.type === "FontMsdfAtlas" &&
          entry.guid === "font-msdf-png:font-1",
      ),
    ).toBe(true);
  });

  it("Preview Build always bundles the debugger", async () => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [asset({ guid: "scene-1", type: "Scene", name: "Main" })],
      plugins: [],
      projectPluginOverrides: {},
      preset: defaultExportPreset(),
      previewBuild: true,
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      bytesByGuid: () => new TextEncoder().encode(JSON.stringify(scene)),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      infiniteLoopDetection: false,
      loopCount: 25,
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.bundleDebugger).toBe(true);
    expect(result.value.manifest.infiniteLoopDetection).toBe(false);
    expect(result.value.manifest.loopCount).toBe(25);
  });

  it("records authored Texture pixel size on packed Texture assets", async () => {
    const scene = createDefaultScene();
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({
          guid: "scene-1",
          type: "Scene",
          name: "Main",
          dependencies: ["tex-1"],
        }),
        asset({ guid: "tex-1", type: "Texture", name: "Banner" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) =>
        guid === "tex-1" ? { width: 1024, height: 512 } : null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new Uint8Array([1, 2, 3]),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "tex-1"),
    ).toMatchObject({ width: 1024, height: 512 });
  });

  it("records pixelsPerUnit and Font family names from payloads", async () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("label", "Label", {
          components: [
            {
              id: "text",
              classId: "Text3DComponent",
              properties: { fontGuid: "font-1" },
            },
          ],
        }),
      ],
    };
    const result = await collectAndExportGame({
      startupSceneGuid: "scene-1",
      assets: [
        asset({ guid: "scene-1", type: "Scene", name: "Main" }),
        asset({ guid: "font-1", type: "Font", name: "Custom Font" }),
      ],
      plugins: [],
      projectPluginOverrides: {},
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
      payloadByGuid: (guid) =>
        guid === "font-1" ? { family: "Display" } : null,
      bytesByGuid: (guid) =>
        guid === "scene-1"
          ? new TextEncoder().encode(JSON.stringify(scene))
          : new Uint8Array([1, 2, 3]),
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60,
      physicsWorld: "3d",
      pixelsPerUnit: 64,
      pixelPerfect: true,
      playerFiles,
    });
    expect(result.ok).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.manifest.pixelsPerUnit).toBe(64);
    expect(result.value.manifest.pixelPerfect).toBe(true);
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "font-1")
        ?.name,
    ).toBe("Display");
  });
});

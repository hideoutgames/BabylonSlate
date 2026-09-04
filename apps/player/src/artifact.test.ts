import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  createDefaultSceneLayer,
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { exportGame, GAME_MANIFEST_FILE, SCRIPTS_FILE } from "@babylonslate/exporter";
import { loadGameFromFiles, loadGameFromHttp } from "./artifact";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function useScriptsFilename(files: Map<string, Uint8Array>, scriptsFile: string) {
  const customized = new Map(files);
  const scripts = customized.get(SCRIPTS_FILE);
  const manifestBytes = customized.get(GAME_MANIFEST_FILE);
  if (!scripts || !manifestBytes) throw new Error("Incomplete test artifact");
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as Record<string, unknown>;
  manifest.scriptsFile = scriptsFile;
  customized.delete(SCRIPTS_FILE);
  customized.set(scriptsFile, scripts);
  customized.set(GAME_MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
  return customized;
}

describe("loadGameFromFiles", () => {
  it("loads scripts from the filename declared by the manifest", async () => {
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;

    const loaded = await loadGameFromFiles(
      useScriptsFilename(packed.value.files, "runtime/custom-scripts.js"),
    );

    expect(loaded.manifest.scriptsFile).toBe("runtime/custom-scripts.js");
    expect(loaded.scripts).toEqual([]);
  });

  it("boots the packed startup scene guid, not a path", async () => {
    const scene = {
      ...createDefaultScene(),
      name: "Arena",
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-guid-1",
      customResolution: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        customResolution: true,
        width: 640,
        height: 360,
        blackBars: true,
      },
      scripts: [],
      assets: [
        {
          guid: "scene-guid-1",
          type: "Scene",
          sceneGuid: "scene-guid-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.manifest.startupSceneGuid).toBe("scene-guid-1");
    expect(loaded.scenes.get("scene-guid-1")?.name).toBe("Arena");
    expect(loaded.manifest.render.width).toBe(640);
    expect(loaded).not.toHaveProperty("userInterfaces");
  });

  it("maps FontFacetype sidecar bytes onto fontFacetypeBytes by Font guid", async () => {
    const scene = { ...createDefaultScene(), name: "Arena" };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
        {
          guid: "font-1",
          type: "Font",
          sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([1, 2]),
        },
        {
          guid: "font-facetype:font-1",
          type: "FontFacetype",
          sceneGuid: "scene-1",
          name: "Display Facetype",
          bytes: new Uint8Array([9, 8, 7]),
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.fontBytes.get("font-1")).toEqual(new Uint8Array([1, 2]));
    expect(loaded.fontFacetypeBytes.get("font-1")).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("maps FontMsdf sidecar bytes onto fontMsdfJson and fontMsdfPng by Font guid", async () => {
    const scene = { ...createDefaultScene(), name: "Arena" };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
        {
          guid: "font-1",
          type: "Font",
          sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([1, 2]),
        },
        {
          guid: "font-msdf:font-1",
          type: "FontMsdf",
          sceneGuid: "scene-1",
          name: "Display MSDF",
          bytes: new Uint8Array([9]),
        },
        {
          guid: "font-msdf-png:font-1",
          type: "FontMsdfAtlas",
          sceneGuid: "scene-1",
          name: "Display MSDF Atlas",
          bytes: new Uint8Array([8]),
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.fontMsdfJson.get("font-1")).toEqual(new Uint8Array([9]));
    expect(loaded.fontMsdfPng.get("font-1")).toEqual(new Uint8Array([8]));
  });

  it("peels packed Model payload so importScale reaches the player", async () => {
    const { encodePackedModelAsset } = await import("@babylonslate/assets");
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]);
    const packedModel = encodePackedModelAsset(
      {
        importScale: 4,
        clipNames: ["Walk"],
        materialSlots: [],
        skeletonGuid: null,
      },
      glb,
    );
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hero-model",
          type: "Model",
          sceneGuid: "scene-1",
          name: "Hero",
          bytes: packedModel,
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.modelBytes.get("hero-model")).toEqual(glb);
    expect(loaded.modelPayloads.get("hero-model")?.importScale).toBe(4);
  });

  it("loads a raw GLB Model pack as source with default payload", async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 9]);
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hero-model",
          type: "Model",
          sceneGuid: "scene-1",
          name: "Hero",
          bytes: glb,
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.modelBytes.get("hero-model")).toEqual(glb);
    expect(loaded.modelPayloads.get("hero-model")?.importScale).toBe(1);
  });

  it("loads packed SceneLayer documents onto the compositor library", async () => {
    const layer = { ...createDefaultSceneLayer(), name: "HUD" };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hud",
          type: "SceneLayer",
          sceneGuid: "scene-1",
          name: "HUD",
          bytes: new TextEncoder().encode(JSON.stringify(layer)),
        },
      ],
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("void 0")],
      ]),
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.sceneLayers.get("hud")?.name).toBe("HUD");
    expect(loaded.manifest.assets.find((entry) => entry.guid === "hud")?.encoding).toBe(
      "json",
    );
  });
});

describe("loadGameFromHttp", () => {
  it("fetches scripts from the filename declared by the manifest", async () => {
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const files = useScriptsFilename(packed.value.files, "runtime/custom-scripts.js");
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push(url);
      const path = new URL(url).pathname.replace(/^\/game\//, "");
      const bytes = files.get(path);
      return new Response(bytes, { status: bytes ? 200 : 404 });
    };

    const loaded = await loadGameFromHttp("https://example.com/game/", fetchImpl);

    expect(loaded.scripts).toEqual([]);
    expect(requested).toEqual([
      "https://example.com/game/game.json",
      "https://example.com/game/runtime/custom-scripts.js",
    ]);
  });
});

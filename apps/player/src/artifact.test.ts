import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  createDefaultSceneLayer,
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { exportGame, GAME_MANIFEST_FILE, SCRIPTS_FILE, AREA_EMISSION_EXPORT_TYPE, areaEmissionExportGuid } from "@babylonslate/exporter";
import { AREA_EMISSION_EDGE, encodeAreaEmission } from "@babylonslate/assets";
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
  it.each(["packed", "loose"] as const)("overlaps asset HTTP requests with a bounded pool (%s)", async (mode) => {
    const result = await exportGame({ mode, bundleDebugger: false, startupSceneGuid: "scene", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [],
      assets: Array.from({ length: 15 }, (_, index) => ({ guid: `texture-${index}`, type: "Texture", startupRequired: true, sceneGuid: "scene", bytes: new Uint8Array([index]) })) });
    if (!result.ok) throw new Error(result.error);
    let active = 0;
    let peak = 0;
    const game = await loadGameFromHttp("https://game.example/", async (input, init) => {
      const path = new URL(String(input)).pathname.slice(1);
      const bytes = result.value.files.get(path);
      if (!bytes) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get("Range");
      const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      const isAsset = path.startsWith("assets/");
      if (isAsset) { active++; peak = Math.max(peak, active); }
      await Promise.resolve();
      if (isAsset) active--;
      return new Response(match ? bytes.subarray(Number(match[1]), Number(match[2]) + 1) : bytes, { status: match ? 206 : 200 });
    });
    expect(game.textureBytes.size).toBe(15);
    expect(game.textureBytes.get("texture-14")).toEqual(new Uint8Array([14]));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });
  it.each([true, false])("loads prepared emission independently of visual texture bytes (packed=%s)", async (pack) => {
    const emission = await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(200), "a".repeat(64));
    const exported = await exportGame({ bundleDebugger: false, startupSceneGuid: "scene", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], mode: pack ? "packed" : "loose", assets: [
      { guid: "texture", type: "Texture", bytes: new Uint8Array([1, 2, 3]), startupRequired: true, sceneGuid: "scene" },
      { guid: areaEmissionExportGuid("texture"), type: AREA_EMISSION_EXPORT_TYPE, bytes: emission, startupRequired: true, sceneGuid: "scene" },
    ] });
    if (!exported.ok) throw new Error(exported.error);
    const game = await loadGameFromFiles(exported.value.files);
    expect(game.textureBytes.get("texture")).toEqual(new Uint8Array([1, 2, 3]));
    expect(game.areaEmissions.get("texture")?.rgba.every((value) => value === 200)).toBe(true);
    emission[emission.length - 1] = 0;
    const corrupted = await exportGame({ bundleDebugger: false, startupSceneGuid: "scene", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], mode: pack ? "packed" : "loose", assets: [{ guid: areaEmissionExportGuid("texture"), type: AREA_EMISSION_EXPORT_TYPE, bytes: emission, startupRequired: true, sceneGuid: "scene" }] });
    if (!corrupted.ok) throw new Error(corrupted.error);
    await expect(loadGameFromFiles(corrupted.value.files)).rejects.toThrow(/corrupt/i);
  });
  it("loads scripts from the filename declared by the manifest", async () => {
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
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
      renderSettings: {
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          startupRequired: true, sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
        {
          guid: "font-1",
          type: "Font",
          startupRequired: true, sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([1, 2]),
        },
        {
          guid: "font-facetype:font-1",
          type: "FontFacetype",
          startupRequired: true, sceneGuid: "scene-1",
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          startupRequired: true, sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
        {
          guid: "font-1",
          type: "Font",
          startupRequired: true, sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([1, 2]),
        },
        {
          guid: "font-msdf:font-1",
          type: "FontMsdf",
          startupRequired: true, sceneGuid: "scene-1",
          name: "Display MSDF",
          bytes: new Uint8Array([9]),
        },
        {
          guid: "font-msdf-png:font-1",
          type: "FontMsdfAtlas",
          startupRequired: true, sceneGuid: "scene-1",
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          startupRequired: true, sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hero-model",
          type: "Model",
          startupRequired: true, sceneGuid: "scene-1",
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          startupRequired: true, sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hero-model",
          type: "Model",
          startupRequired: true, sceneGuid: "scene-1",
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          startupRequired: true, sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(createDefaultScene())),
        },
        {
          guid: "hud",
          type: "SceneLayer",
          startupRequired: true, sceneGuid: "scene-1",
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
      renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
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


describe("demand-driven exported sources", () => {
  it.each(["packed", "loose"] as const)("keeps deferred assets unread, shares source reads, and releases the last consumer (%s)", async mode => {
    const scene = encoder.encode(JSON.stringify(createDefaultScene()));
    const exported = await exportGame({ mode, bundleDebugger: false, startupSceneGuid: "a", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], assets: [
      { guid: "a", type: "Scene", sceneGuid: "a", bytes: scene, dependencies: ["b"], requiredDependencies: [] },
      { guid: "b", type: "Scene", sceneGuid: "b", bytes: scene, requiredDependencies: ["texture"] },
      { guid: "texture", type: "Texture", sceneGuid: "b", bytes: new Uint8Array([1, 2, 3]), requiredDependencies: [] },
    ] });
    if (!exported.ok) throw new Error(exported.error);
    const reads: string[] = [];
    const game = await loadGameFromHttp("https://offline.local/", async input => {
      const path = new URL(String(input)).pathname.slice(1);
      reads.push(path);
      const bytes = exported.value.files.get(path);
      return new Response(bytes, { status: bytes ? 200 : 404 });
    });
    try {
      expect(reads).toEqual(["game.json", "scripts.js", "assets/data-0.bin"]);
      expect(game.scenes.has("b")).toBe(false);
      expect(game.textureBytes.size).toBe(0);
      const controller = new AbortController();
      const [first, second] = await Promise.all([game.acquireScene!("b", { consumer: "one", signal: controller.signal }), game.acquireScene!("b", { consumer: "two", signal: controller.signal })]);
      expect(reads.filter(path => path === "assets/data-1.bin")).toHaveLength(1);
      expect(reads.filter(path => path === "assets/data-2.bin")).toHaveLength(1);
      first.release();
      expect(game.textureBytes.get("texture")).toEqual(new Uint8Array([1, 2, 3]));
      second.release();
      game.assets!.trim({ force: true });
      expect(game.scenes.has("b")).toBe(false);
      expect(game.textureBytes.size).toBe(0);
      expect(game.scenes.has("a")).toBe(true);
    } finally { game.dispose?.(); }
  });

  it("does not publish a failed scene dependency and permits a later retry", async () => {
    const scene = encoder.encode(JSON.stringify(createDefaultScene()));
    const exported = await exportGame({ bundleDebugger: false, startupSceneGuid: "a", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], assets: [
      { guid: "a", type: "Scene", sceneGuid: "a", bytes: scene, requiredDependencies: [] },
      { guid: "b", type: "Scene", sceneGuid: "b", bytes: scene, requiredDependencies: ["texture"] },
      { guid: "texture", type: "Texture", sceneGuid: "b", bytes: new Uint8Array([1]), requiredDependencies: [] },
    ] });
    if (!exported.ok) throw new Error(exported.error);
    let missing = true;
    const game = await loadGameFromHttp("https://offline.local/", async input => {
      const path = new URL(String(input)).pathname.slice(1);
      const bytes = missing && path === "assets/data-2.bin" ? undefined : exported.value.files.get(path);
      return new Response(bytes, { status: bytes ? 200 : 404 });
    });
    try {
      const request = { consumer: "stream", signal: new AbortController().signal };
      await expect(game.acquireScene!("b", request)).rejects.toThrow(/texture.*stream/);
      expect(game.scenes.has("b")).toBe(false);
      missing = false;
      const source = await game.acquireScene!("b", request);
      expect(game.scenes.has("b")).toBe(true);
      source.release();
    } finally { game.dispose?.(); }
  });
});

it("cancels a cold offline scene before publication and ignores its late storage completion", async () => {
  const scene = encoder.encode(JSON.stringify(createDefaultScene()));
  const exported = await exportGame({ bundleDebugger: false, startupSceneGuid: "a", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], assets: [
    { guid: "a", type: "Scene", sceneGuid: "a", bytes: scene, requiredDependencies: [] },
    { guid: "b", type: "Scene", sceneGuid: "b", bytes: scene, requiredDependencies: ["texture"] },
    { guid: "texture", type: "Texture", sceneGuid: "b", bytes: new Uint8Array([7]), requiredDependencies: [] },
  ] });
  if (!exported.ok) throw new Error(exported.error);
  const files = exported.value.files;
  let finish!: (bytes: Uint8Array) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let delayed = true;
  const game = await loadGameFromFiles(new Map([[GAME_MANIFEST_FILE, files.get(GAME_MANIFEST_FILE)!], [SCRIPTS_FILE, files.get(SCRIPTS_FILE)!]]), {
    readFile: async path => {
      if (delayed && path === "assets/data-2.bin") { began(); return new Promise(resolve => { finish = resolve; }); }
      return files.get(path)!;
    },
  });
  try {
    const controller = new AbortController();
    const loading = game.acquireScene!("b", { consumer: "cancelled offline instance", signal: controller.signal });
    await started;
    controller.abort(new Error("Instance unloaded"));
    await expect(loading).rejects.toThrow(/cancel|unload/i);
    expect(game.scenes.has("b")).toBe(false);
    delayed = false;
    finish(new Uint8Array([7]));
    const current = await game.acquireScene!("b", { consumer: "replacement instance", signal: new AbortController().signal });
    expect(game.textureBytes.get("texture")).toEqual(new Uint8Array([7]));
    current.release();
    game.assets!.trim({ force: true });
    expect(game.payloads.has("b")).toBe(false);
    expect(game.payloads.has("texture")).toBe(false);
    expect(game.assets!.snapshot().entries.every(entry => entry.owners.every(owner => !owner.includes("cancelled offline instance")))).toBe(true);
  } finally { game.dispose?.(); }
});

it("rejects a corrupt deferred deployed file without reading it during startup and retries after repair", async () => {
  const scene = encoder.encode(JSON.stringify(createDefaultScene()));
  const exported = await exportGame({ bundleDebugger: false, startupSceneGuid: "a", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], assets: [
    { guid: "a", type: "Scene", sceneGuid: "a", bytes: scene, requiredDependencies: [] },
    { guid: "b", type: "Scene", sceneGuid: "b", bytes: scene, requiredDependencies: [] },
  ] });
  if (!exported.ok) throw new Error(exported.error);
  const files = exported.value.files;
  const valid = files.get("assets/data-1.bin")!;
  const corrupt = valid.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  files.set("assets/data-1.bin", corrupt);
  const game = await loadGameFromFiles(files);
  try {
    expect(game.scenes.has("b")).toBe(false);
    await expect(game.acquireScene!("b", { consumer: "offline stream", signal: new AbortController().signal })).rejects.toThrow(/corrupt revision/i);
    files.set("assets/data-1.bin", valid);
    const source = await game.acquireScene!("b", { consumer: "repaired stream", signal: new AbortController().signal });
    expect(source.scene).toEqual(game.scenes.get("a"));
    source.release();
  } finally { game.dispose?.(); }
});

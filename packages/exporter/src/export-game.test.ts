import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { exportGame, zipExport, unzipExport, parseGameManifest, SAFE_ZIP_MTIME } from "./export-game";
import { parseScriptRegistry } from "./scripts";
import { GAME_MANIFEST_FILE } from "./constants";

function stubPlayer(): Map<string, Uint8Array> {
  const html = `<!doctype html><html><body>
<canvas id="game"></canvas>
<script type="module" src="./player.js"></script>
</body></html>`;
  return new Map([
    ["index.html", new TextEncoder().encode(html)],
    ["player.js", new TextEncoder().encode("console.log('player')")],
  ]);
}

describe("exportGame", () => {
  it("puts index.html at the zip root and records startupSceneGuid", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        customResolution: true,
        width: 1280,
        height: 720,
        blackBars: true,
      },
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode('{"name":"Main"}'),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.has("index.html")).toBe(true);
    expect(result.value.manifest.startupSceneGuid).toBe("scene-1");
    expect(result.value.manifest.render).toEqual({
      customResolution: true,
      width: 1280,
      height: 720,
      blackBars: true,
    });
    expect(result.value.manifest.bundleDebugger).toBe(false);
    expect(result.value.fileCount).toBeLessThan(800);
    expect(result.value.manifest.assets.some((entry) => entry.guid === "scene-1")).toBe(
      true,
    );
    const zip = zipExport(result.value);
    const unzipped = unzipExport(zip);
    expect(Object.keys(unzipped)).toContain("index.html");
    expect(Object.keys(unzipped)).toContain(GAME_MANIFEST_FILE);
    expect(unzipped["index.html"]).toBeDefined();
  });

  it("zips with a DOS-safe local noon mtime", () => {
    expect(SAFE_ZIP_MTIME.getFullYear()).toBe(1980);
    expect(SAFE_ZIP_MTIME.getHours()).toBe(12);
    const artifact = {
      files: new Map([["index.html", new Uint8Array([1])]]),
      fileCount: 1,
      warnings: [] as string[],
      manifest: {
        version: 1 as const,
        startupSceneGuid: "s",
        assets: [],
        occlusionEnabled: true,
        reverbWetScale: 1,
        reverbDecayScale: 1,
        reverbDampingScale: 1,
        bundleDebugger: false,
        pixelsPerUnit: 100,
        pixelPerfect: false,
      },
    };
    expect(() => zipExport(artifact as never)).not.toThrow();
    expect(zipExport(artifact as never).byteLength).toBeGreaterThan(0);
  });

  it("defaults to packed mode with a boot pack", async () => {
    const result = await exportGame({
      bundleDebugger: true,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.mode).toBe("packed");
    expect(result.value.files.has("boot.babpack")).toBe(true);
    expect(result.value.manifest.bundleDebugger).toBe(true);
  });

  it("omits infinite loop fields from a release manifest", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
      infiniteLoopDetection: true,
      loopCount: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.infiniteLoopDetection).toBeUndefined();
    expect(result.value.manifest.loopCount).toBeUndefined();
    const json = JSON.parse(
      new TextDecoder().decode(result.value.files.get(GAME_MANIFEST_FILE)),
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty("infiniteLoopDetection");
    expect(json).not.toHaveProperty("loopCount");
  });

  it("records infinite loop settings when the debugger is bundled", async () => {
    const result = await exportGame({
      bundleDebugger: true,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
      infiniteLoopDetection: false,
      loopCount: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.infiniteLoopDetection).toBe(false);
    expect(result.value.manifest.loopCount).toBe(50);
  });

  it("groups reached scenes into separate packs", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
        {
          guid: "tex-boot",
          type: "Texture",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([2]),
        },
        {
          guid: "scene-2",
          type: "Scene",
          sceneGuid: "scene-2",
          bytes: new Uint8Array([3]),
        },
        {
          guid: "tex-2",
          type: "Texture",
          sceneGuid: "scene-2",
          bytes: new Uint8Array([4]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.packs).toEqual(
      expect.arrayContaining(["boot.babpack", "scene-scene-2.babpack"]),
    );
    expect(result.value.files.has("scene-scene-2.babpack")).toBe(true);
  });

  it("keeps loose mode as one file per asset", async () => {
    const result = await exportGame({
      mode: "loose",
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
        {
          guid: "tex-1",
          type: "Texture",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([2]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.mode).toBe("loose");
    expect(result.value.files.has("assets/scene-1.bin")).toBe(true);
    expect(result.value.files.has("assets/tex-1.bin")).toBe(true);
    expect(result.value.files.has("boot.babpack")).toBe(false);
  });

  it("records authored Texture pixel size on the manifest index", async () => {
    const result = await exportGame({
      mode: "loose",
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
        {
          guid: "tex-1",
          type: "Texture",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([2]),
          width: 1024,
          height: 512,
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "tex-1"),
    ).toMatchObject({ width: 1024, height: 512 });
  });

  it("fails when the file count exceeds the hard limit", async () => {
    const extras = new Map<string, Uint8Array>();
    for (let i = 0; i < 5; i++) {
      extras.set(`extra-${i}.dat`, new Uint8Array([i]));
    }
    const result = await exportGame({
      mode: "loose",
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
      extraFiles: extras,
      fileCountFail: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/1000|file count|4/i);
  });

  it("warns when the file count crosses the warn threshold", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
      fileCountWarn: 1,
      fileCountFail: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.some((warning) => /800|file count|1/i.test(warning))).toBe(
      true,
    );
  });

  it("writes a parseable script registry and generates index.html when omitted", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [
        {
          assetGuid: "hero",
          classId: "Hero",
          source: "export function onBeginPlay() {}\n",
          anchors: [
            {
              line: 1,
              column: 0,
              assetGuid: "hero",
              graphId: "event-graph",
              nodeId: "n1",
            },
          ],
          entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
        },
      ],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = new TextDecoder().decode(result.value.files.get("index.html"));
    expect(html).toContain("player.js");
    expect(html.toLowerCase()).toContain("<!doctype html>");
    const scripts = new TextDecoder().decode(result.value.files.get("scripts.js"));
    expect(scripts).toContain("Hero");
    expect(scripts).toContain("globalThis.__babylonslateScripts");
    expect(scripts).toContain("sourceURL=babylonslate:///hero.js");
    expect(parseScriptRegistry(scripts)[0]?.anchors[0]?.line).toBe(1);
  });

  it("packs Havok wasm for 3d and Rapier for 2d, not both", async () => {
    const player = new Map([
      ["index.html", new TextEncoder().encode("<html></html>")],
      ["player.js", new TextEncoder().encode("void 0")],
      ["havok/HavokPhysics.wasm", new Uint8Array([1])],
      ["assets/HavokPhysics_es.js", new TextEncoder().encode("havok")],
      ["assets/rapier.es.js", new TextEncoder().encode("rapier")],
      ["coi-serviceworker.js", new TextEncoder().encode("/* coi */")],
    ]);
    const three = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      physicsWorld: "3d",
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: player,
    });
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    expect(three.value.files.has("havok/HavokPhysics.wasm")).toBe(true);
    expect(three.value.files.has("assets/HavokPhysics_es.js")).toBe(true);
    expect(three.value.files.has("assets/rapier.es.js")).toBe(false);

    const two = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      physicsWorld: "2d",
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: player,
    });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.value.files.has("assets/rapier.es.js")).toBe(true);
    expect(two.value.files.has("havok/HavokPhysics.wasm")).toBe(false);
    expect(two.value.files.has("assets/HavokPhysics_es.js")).toBe(false);
  });

  it("inlines CSS into index.html and keeps wasm as a real file", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: new Map([
        [
          "index.html",
          new TextEncoder().encode(
            `<!doctype html><html><head><link rel="stylesheet" href="./player.css"></head><body><script src="./player.js"></script></body></html>`,
          ),
        ],
        ["player.css", new TextEncoder().encode("canvas{display:block}")],
        ["player.js", new TextEncoder().encode("void 0")],
        ["havok/HavokPhysics.wasm", new Uint8Array([0, 97, 115, 109])],
        ["coi-serviceworker.js", new TextEncoder().encode("/* coi */")],
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = new TextDecoder().decode(result.value.files.get("index.html"));
    expect(html).toContain("canvas{display:block}");
    expect(result.value.files.has("player.css")).toBe(false);
    expect(result.value.files.has("havok/HavokPhysics.wasm")).toBe(true);
    expect(result.value.files.has("coi-serviceworker.js")).toBe(true);
    expect(result.value.fileCount).toBeLessThan(800);
  });

  it("records pixelsPerUnit and Font names on the manifest", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      pixelsPerUnit: 64,
      pixelPerfect: true,
      touchMinTargetPx: 48,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
        {
          guid: "font-1",
          type: "Font",
          sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([2, 3]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.pixelsPerUnit).toBe(64);
    expect(result.value.manifest.pixelPerfect).toBe(true);
    expect(result.value.manifest.touchMinTargetPx).toBe(48);
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "font-1")?.name,
    ).toBe("Display");
  });

  it("defaults pixelsPerUnit when game.json omits 2D fields", () => {
    const manifest = parseGameManifest(
      JSON.stringify({
        startupSceneGuid: "scene-1",
        bundleDebugger: false,
        mode: "packed",
        render: DEFAULT_RENDER_PROJECT_SETTINGS,
        playFrameCap: 60,
        packs: [],
        scriptsFile: "scripts.js",
        physicsWorld: "3d",
        assets: [],
        ui: {
          designResolution: { width: 1280, height: 720 },
          scaleRule: "fitWidth",
        },
        uiDesignerPresets: [
          {
            id: "phone",
            label: "Phone",
            width: 390,
            height: 844,
            safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
          },
        ],
      }),
    );
    expect(manifest.pixelsPerUnit).toBe(100);
    expect(manifest.pixelPerfect).toBe(false);
    expect(manifest.touchMinTargetPx).toBe(44);
    expect(manifest.infiniteLoopDetection).toBeUndefined();
    expect(manifest.loopCount).toBeUndefined();
    expect(manifest.occlusionEnabled).toBe(true);
    expect(manifest).not.toHaveProperty("ui");
    expect(manifest).not.toHaveProperty("uiDesignerPresets");
  });

  it("writes Audio occlusion into game.json", async () => {
    const on = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value.manifest.occlusionEnabled).toBe(true);
    const off = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      occlusionEnabled: false,
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.manifest.occlusionEnabled).toBe(false);
    expect(
      parseGameManifest(
        new TextDecoder().decode(off.value.files.get(GAME_MANIFEST_FILE)!),
      ).occlusionEnabled,
    ).toBe(false);
  });

  it("writes Audio reverb scales into game.json", async () => {
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      reverbWetScale: 1.5,
      reverbDecayScale: 0.25,
      reverbDampingScale: 2,
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([1]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.reverbWetScale).toBe(1.5);
    expect(result.value.manifest.reverbDecayScale).toBe(0.25);
    expect(result.value.manifest.reverbDampingScale).toBe(2);
    expect(
      parseGameManifest(
        JSON.stringify({
          startupSceneGuid: "scene-1",
          bundleDebugger: false,
          mode: "packed",
          render: DEFAULT_RENDER_PROJECT_SETTINGS,
          playFrameCap: 60,
          packs: [],
          scriptsFile: "scripts.js",
          physicsWorld: "3d",
          assets: [],
        }),
      ),
    ).toMatchObject({
      reverbWetScale: 1,
      reverbDecayScale: 1,
      reverbDampingScale: 1,
    });
  });

  it("defaults bundled debugger loop settings when game.json omits them", () => {
    const manifest = parseGameManifest(
      JSON.stringify({
        startupSceneGuid: "scene-1",
        bundleDebugger: true,
        mode: "packed",
        render: DEFAULT_RENDER_PROJECT_SETTINGS,
        playFrameCap: 60,
        packs: [],
        scriptsFile: "scripts.js",
        physicsWorld: "3d",
        assets: [],
      }),
    );
    expect(manifest.infiniteLoopDetection).toBe(true);
    expect(manifest.loopCount).toBe(1_000_000);
  });

  it("records Animation catalog payloads as JSON", async () => {
    const payload = {
      clipName: "Idle",
      modelGuid: "hero-model",
      skeletonGuid: "hero-skel",
      durationMs: 1800,
    };
    const result = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode('{"name":"Main"}'),
        },
        {
          guid: "hero-idle-anim",
          type: "Animation",
          sceneGuid: "scene-1",
          name: "Hero_Idle",
          bytes: new TextEncoder().encode(JSON.stringify(payload)),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "hero-idle-anim"),
    ).toEqual(
      expect.objectContaining({
        guid: "hero-idle-anim",
        type: "Animation",
        encoding: "json",
        name: "Hero_Idle",
      }),
    );
  });

  it("records Font names on loose-mode index entries", async () => {
    const result = await exportGame({
      mode: "loose",
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      scripts: [],
      assets: [
        {
          guid: "font-1",
          type: "Font",
          sceneGuid: "scene-1",
          name: "Display",
          bytes: new Uint8Array([2, 3]),
        },
      ],
      playerFiles: stubPlayer(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.manifest.assets.find((entry) => entry.guid === "font-1")?.name,
    ).toBe("Display");
  });
});

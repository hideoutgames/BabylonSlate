import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { exportGame, zipExport, unzipExport } from "./export-game";
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
});

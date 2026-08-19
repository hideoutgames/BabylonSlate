import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { exportGame } from "@babylonslate/exporter";
import { loadGameFromFiles } from "./artifact";

describe("loadGameFromFiles", () => {
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
  });

  it("hydrates packed UserInterface documents into a guid-keyed library", async () => {
    const scene = { ...createDefaultScene(), name: "Arena" };
    const hud = {
      name: "HUD",
      rootId: "canvas",
      widgets: {
        canvas: { id: "canvas", kind: "Canvas", name: "Canvas", children: ["play-btn"] },
        "play-btn": { id: "play-btn", kind: "Button", name: "Play" },
      },
    };
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
          guid: "hud-1",
          type: "UserInterface",
          sceneGuid: "scene-1",
          name: "HUD",
          bytes: new TextEncoder().encode(JSON.stringify(hud)),
        },
        {
          guid: "eui-1",
          type: "EditorUtilityInterface",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify({ name: "Dock" })),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const loaded = await loadGameFromFiles(packed.value.files);
    expect(loaded.userInterfaces.get("hud-1")?.name).toBe("HUD");
    expect(loaded.userInterfaces.get("hud-1")?.widgets["play-btn"]?.kind).toBe("Button");
    expect(loaded.userInterfaces.has("eui-1")).toBe(false);
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
});

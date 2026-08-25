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
});

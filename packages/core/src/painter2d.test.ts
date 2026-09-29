import { describe, expect, it } from "vitest";
import { parsePainter2DProperties, painterTextureSize } from "./painter2d";
import { normalizeSceneLayer, sceneLayerToEditorScene, editorSceneToSceneLayer } from "./scene-layer";

describe("Painter documents", () => {
  it("preserves paths and cutouts through SceneLayer editor save and rejects malformed geometry", () => {
    const layer = normalizeSceneLayer({ actors: [{ id: "paint", classId: "SceneLayerActor", components: [{ id: "ink", classId: "2DPainterComponent", properties: {
      clearEachFrame: false, width: 8, height: 4, commands: [
        { kind: "popMask" },
        { kind: "cutout", fillRule: "evenodd", path: [{ kind: "move", point: [0, 0] }, { kind: "quadratic", control: [1, 2], point: [2, 0] }, { kind: "close" }] },
        { kind: "draw", path: [{ kind: "ellipse", center: [0, 0], radius: [-1, 1] }] },
      ],
    } }] }] });
    const saved = editorSceneToSceneLayer(sceneLayerToEditorScene(layer));
    const painter = parsePainter2DProperties(saved.actors[0]!.components[0]!.properties);
    expect(painter).toMatchObject({ width: 8, height: 4, clearEachFrame: false, commands: [{ kind: "cutout", fillRule: "evenodd", path: [{ kind: "move", point: [0, 0] }, { kind: "quadratic", control: [1, 2], point: [2, 0] }, { kind: "close" }] }] });
  });
  it("fits large canvases into the texture and working pixel limits without changing aspect", () => {
    expect(painterTextureSize(100, 50, 100)).toEqual({ width: 2896, height: 1448 });
    expect(painterTextureSize(100, 1, 100, 2048)).toEqual({ width: 2048, height: 20 });
    expect(painterTextureSize(1, 1, 100)).toEqual({ width: 100, height: 100 });
  });
});

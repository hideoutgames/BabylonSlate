import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { isLayerDepthVisual, markLayerDepthVisual } from "./layer-depth-visuals";
import { drawsLayer3DWithDepth } from "./material-compiler";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** A Scene Layer Material as the compiler leaves it for `overlay` (every draw blends), with the decision installed. */
function layerMaterial(blendMode: "opaque" | "masked" | "translucent" | "additive", domain: "surface" | "ui" = "surface") {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const material = new StandardMaterial("layer", scene);
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  drawsLayer3DWithDepth(material, { domain, blendMode });
  /** A 3D visual's root and a part under it, as a model's parts load, and a 2D quad. */
  const root = new Mesh("actor-1", scene);
  markLayerDepthVisual(root);
  const box = MeshBuilder.CreateBox("box", {}, scene);
  box.parent = root;
  const quad = MeshBuilder.CreatePlane("quad", {}, scene);
  const list = (mesh: Mesh) => material.needAlphaBlendingForMesh(mesh) ? "blended" : material.needAlphaTestingForMesh(mesh) ? "alpha-tested" : "opaque";
  return { material, root, box, quad, list };
}

describe("a Scene Layer Material on 3D visuals", () => {
  it("draws a 3D visual's parts opaque or alpha-tested, with depth writes, for an Opaque or Masked Material", () => {
    const opaque = layerMaterial("opaque");
    expect(isLayerDepthVisual(opaque.box)).toBe(true);
    expect([opaque.list(opaque.root), opaque.list(opaque.box)]).toEqual(["opaque", "opaque"]);
    const masked = layerMaterial("masked");
    expect(masked.list(masked.box)).toBe("alpha-tested");
  });

  it("keeps 2D layer content blended, sorted by Z-Order, whatever the blend mode", () => {
    for (const blendMode of ["opaque", "masked", "translucent"] as const) {
      const { quad, list } = layerMaterial(blendMode);
      expect(isLayerDepthVisual(quad)).toBe(false);
      expect(list(quad), blendMode).toBe("blended");
    }
  });

  it("blends a 3D visual drawn with a blended Material, another domain's, or one that fades", () => {
    for (const blendMode of ["translucent", "additive"] as const) {
      const { box, list } = layerMaterial(blendMode);
      expect(list(box), blendMode).toBe("blended");
    }
    const ui = layerMaterial("opaque", "ui");
    expect(ui.list(ui.box)).toBe("blended");
    const faded = layerMaterial("masked");
    faded.box.visibility = 0.5;
    expect(faded.list(faded.box)).toBe("blended");
    faded.box.visibility = 1;
    faded.box.hasVertexAlpha = true;
    expect(faded.list(faded.box)).toBe("blended");
  });
});

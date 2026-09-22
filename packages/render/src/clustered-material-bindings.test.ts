import { describe, expect, it } from "vitest";
import {
  LightBlock,
  NodeMaterial,
  NullEngine,
  Scene,
  ShaderLanguage,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { bindClusteredMaterialVariants } from "./clustered-material-bindings";

function fixture(shaderLanguage: ShaderLanguage) {
  const scene = new Scene(new NullEngine());
  const material = new NodeMaterial("material", scene);
  material.shaderLanguage = shaderLanguage;
  const light = new LightBlock("light");
  // The wrapper calls the instance slot first; isolate the adapter's push.
  light.updateUniformsAndSamples = () => {};
  material.attachedBlocks.push(light);
  bindClusteredMaterialVariants(material);
  const state = { samplers: [] as string[] };
  const defines = {
    LIGHT0: true,
    CLUSTLIGHT0: true,
  } as unknown as NodeMaterialDefines;
  const update = () =>
    light.updateUniformsAndSamples(
      state as unknown as NodeMaterialBuildState,
      material,
      defines,
      [],
    );
  return { material, update, state, scene };
}

describe("bindClusteredMaterialVariants", () => {
  it("pushes the mask sampler pair under GLSL", () => {
    const { update, state, scene } = fixture(ShaderLanguage.GLSL);
    update();
    expect(state.samplers).toEqual(["lightDataTexture0", "tileMaskTexture0"]);
    scene.dispose();
  });

  it("pushes only the light data texture under WGSL storage buffers", () => {
    const { update, state, scene } = fixture(ShaderLanguage.WGSL);
    update();
    expect(state.samplers).toEqual(["lightDataTexture0"]);
    scene.dispose();
  });
});

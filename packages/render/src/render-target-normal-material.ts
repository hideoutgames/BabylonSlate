import {
  Constants, DiscardBlock, InputBlock, Material, NodeMaterial, NodeMaterialBlockConnectionPointTypes,
  ShaderLanguage, Texture, TextureBlock,
  type NodeMaterialBlock, type Scene,
} from "@babylonjs/core";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import type { MaterialPlumbing } from "./material-block-registry";
import { createGeometryCaptureOutput } from "./geometry-capture-output";
import { applyLatticeDeformerPlumbing } from "./lattice-deformer-block";
import { registerClusteredUnlitMaterial } from "./clustered-material-policy";

/** Geometry captures share bones, morphs and instancing with surface materials.
 * Their shaders evaluate only the selected output and an optional native mask. */
function createGeometryMaterial(scene: Scene, depth: boolean, source?: Material): NodeMaterial {
  const material = new NodeMaterial(depth ? "renderTarget:depth" : "renderTarget:worldNormal", scene, {
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  // Fragment alpha is data, not a request to blend or disable depth writes.
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.alphaMode = Constants.ALPHA_DISABLE;
  material.allowShaderHotSwapping = false;
  if (source) {
    material.backFaceCulling = source.backFaceCulling;
    material.cullBackFaces = source.cullBackFaces;
  }
  registerClusteredUnlitMaterial(material);
  const blocks: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing(material.name, blocks, plumbing);
  applyLatticeDeformerPlumbing(material.name, blocks, plumbing, scene);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const fragment = createGeometryCaptureOutput(scene, depth, blocks, plumbing);
  const maskTexture = source?.needAlphaTesting() ? source.getAlphaTestTexture() : null;
  if (maskTexture instanceof Texture) {
    const sample = new TextureBlock("captureAlphaMask");
    sample.texture = maskTexture;
    const coordinatesIndex = maskTexture.coordinatesIndex;
    if (coordinatesIndex === 0) plumbing.uv!.connectTo(sample.uv);
    else if (coordinatesIndex === 1) plumbing.uv2!.connectTo(sample.uv);
    else {
      const uv = new InputBlock("captureMaskUv", undefined, NodeMaterialBlockConnectionPointTypes.Vector2);
      uv.setAsAttribute(`uv${coordinatesIndex + 1}`);
      uv.output.connectTo(sample.uv);
      blocks.push(uv);
    }
    const cutoff = new InputBlock("captureAlphaCutoff");
    const readCutoff = () => {
      const value = (source as Material & { alphaCutOff?: number }).alphaCutOff;
      return typeof value === "number" ? value : 0.4;
    };
    cutoff.value = readCutoff();
    cutoff.valueCallback = readCutoff;
    const discard = new DiscardBlock("captureAlphaDiscard");
    sample.a.connectTo(discard.value);
    cutoff.output.connectTo(discard.cutoff);
    blocks.push(sample, cutoff, discard);
    outputs.push(discard);
    material.onDisposeObservable.addOnce(() => { sample.texture = null; });
  }
  for (const output of [...outputs, fragment]) material.addOutputNode(output);
  material.onDisposeObservable.addOnce(() => {
    for (const block of blocks) block.dispose();
  });
  material.build();
  return material;
}

export function createRenderTargetNormalMaterial(scene: Scene, source?: Material): NodeMaterial {
  return createGeometryMaterial(scene, false, source);
}

export function createRenderTargetDepthMaterial(scene: Scene, source?: Material): NodeMaterial {
  return createGeometryMaterial(scene, true, source);
}

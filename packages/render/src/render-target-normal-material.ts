import {
  DiscardBlock, FragmentOutputBlock, InputBlock, NodeMaterial, NormalizeBlock, RemapBlock, ShaderLanguage, Texture, TextureBlock,
  type Material, type NodeMaterialBlock, type Scene,
} from "@babylonjs/core";
import { createSurfacePlumbing } from "./material-compiler";
import type { MaterialPlumbing } from "./material-block-registry";
import { registerClusteredUnlitMaterial } from "./clustered-material-policy";

/** Geometry normals share the surface path's bones, morphs and instancing.
 * Only native alpha-cutout textures are sampled; lighting and scene buffers
 * are absent. */
export function createRenderTargetNormalMaterial(scene: Scene, source?: Material): NodeMaterial {
  const material = new NodeMaterial("renderTarget:worldNormal", scene, {
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  if (source) material.backFaceCulling = source.backFaceCulling;
  registerClusteredUnlitMaterial(material);
  const blocks: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing(material.name, blocks, plumbing);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const normal = new NormalizeBlock("captureNormal");
  plumbing.worldNormal!.connectTo(normal.input);
  const encoded = new RemapBlock("encodeNormal");
  encoded.sourceRange.set(-1, 1);
  encoded.targetRange.set(0, 1);
  normal.output.connectTo(encoded.input);
  const fragment = new FragmentOutputBlock("captureNormalOutput");
  encoded.output.connectTo(fragment.rgb);
  const alpha = new InputBlock("captureNormalAlpha");
  alpha.value = 1;
  alpha.output.connectTo(fragment.a);
  blocks.push(normal, encoded, fragment, alpha);
  const maskTexture = source?.needAlphaTesting() ? source.getAlphaTestTexture() : null;
  if (maskTexture instanceof Texture) {
    const sample = new TextureBlock("captureAlphaMask");
    sample.texture = maskTexture;
    plumbing.uv!.connectTo(sample.uv);
    const cutoff = new InputBlock("captureAlphaCutoff");
    const sourceCutoff = (source as Material & { alphaCutOff?: number }).alphaCutOff;
    cutoff.value = typeof sourceCutoff === "number" ? sourceCutoff : 0.4;
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

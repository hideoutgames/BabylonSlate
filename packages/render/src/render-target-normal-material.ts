import {
  Constants, DiscardBlock, FragmentOutputBlock, InputBlock, Material, MultiplyBlock, NodeMaterial, NodeMaterialBlockConnectionPointTypes,
  NodeMaterialSystemValues, NormalizeBlock, RemapBlock, ShaderLanguage, Texture, TextureBlock, TransformBlock, VectorMergerBlock, VectorSplitterBlock,
  type NodeMaterialBlock, type Scene,
} from "@babylonjs/core";
import { createSurfacePlumbing } from "./material-compiler";
import type { MaterialPlumbing } from "./material-block-registry";
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
  if (source) {
    material.backFaceCulling = source.backFaceCulling;
    material.cullBackFaces = source.cullBackFaces;
  }
  registerClusteredUnlitMaterial(material);
  const blocks: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing(material.name, blocks, plumbing);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const fragment = new FragmentOutputBlock("captureGeometryOutput");
  const alpha = new InputBlock("captureGeometryAlpha");
  alpha.value = 1;
  alpha.output.connectTo(fragment.a);
  blocks.push(fragment, alpha);
  if (depth) {
    const viewPosition = new TransformBlock("captureViewPosition");
    plumbing.worldPosition!.connectTo(viewPosition.vector);
    plumbing.view!.connectTo(viewPosition.transform);
    const viewComponents = new VectorSplitterBlock("captureViewComponents");
    viewPosition.output.connectTo(viewComponents.xyzw);
    const handedness = new InputBlock("captureDepthHandedness");
    handedness.value = scene.useRightHandedSystem ? -1 : 1;
    const distance = new MultiplyBlock("captureCameraDistance");
    viewComponents.z.connectTo(distance.left);
    handedness.output.connectTo(distance.right);
    const camera = new InputBlock("captureCameraParameters");
    camera.setAsSystemValue(NodeMaterialSystemValues.CameraParameters);
    const cameraComponents = new VectorSplitterBlock("captureCameraComponents");
    camera.output.connectTo(cameraComponents.xyzw);
    const normalized = new RemapBlock("captureNormalizedDepth");
    distance.output.connectTo(normalized.input);
    cameraComponents.y.connectTo(normalized.sourceMin);
    cameraComponents.z.connectTo(normalized.sourceMax);
    normalized.targetRange.set(0, 1);
    const red = new VectorMergerBlock("captureDepthRed");
    normalized.output.connectTo(red.x);
    red.xyzOut.connectTo(fragment.rgb);
    blocks.push(viewPosition, viewComponents, handedness, distance, camera, cameraComponents, normalized, red);
  } else {
    const normal = new NormalizeBlock("captureNormal");
    plumbing.worldNormal!.connectTo(normal.input);
    const encoded = new RemapBlock("encodeNormal");
    encoded.sourceRange.set(-1, 1);
    encoded.targetRange.set(0, 1);
    normal.output.connectTo(encoded.input);
    encoded.output.connectTo(fragment.rgb);
    blocks.push(normal, encoded);
  }
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

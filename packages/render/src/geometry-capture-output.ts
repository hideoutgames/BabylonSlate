import {
  FragmentOutputBlock, InputBlock, MultiplyBlock, NodeMaterialSystemValues, NormalizeBlock,
  RemapBlock, TransformBlock, VectorMergerBlock, VectorSplitterBlock,
  type NodeMaterialBlock, type Scene,
} from "@babylonjs/core";
import type { MaterialPlumbing } from "./material-block-registry";

/** The same geometry-data contract for native and retained authored captures. */
export function createGeometryCaptureOutput(
  scene: Scene, depth: boolean, blocks: NodeMaterialBlock[], plumbing: MaterialPlumbing,
): FragmentOutputBlock {
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
  return fragment;
}

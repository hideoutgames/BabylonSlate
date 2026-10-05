import {
  BonesBlock, InputBlock, InstancesBlock, MorphTargetsBlock, NodeMaterialBlockConnectionPointTypes,
  NodeMaterialSystemValues, TransformBlock, VertexOutputBlock, ViewDirectionBlock, type NodeMaterialBlock,
} from "@babylonjs/core";
import type { MaterialPlumbing } from "./material-block-registry";
function matrixInput(
  name: string,
  systemValue: NodeMaterialSystemValues,
): InputBlock {
  const block = new InputBlock(
    // Babylon's floating-origin adapter recognizes u_World/u_View prefixes.
    // Keep the system matrix first; authored material names may be arbitrary.
    `${NodeMaterialSystemValues[systemValue]}_${name}`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Matrix,
  );
  block.setAsSystemValue(systemValue);
  return block;
}

/** Vertex transform and world geometry shared by surfaces and coverage passes. */
export function createSurfacePlumbing(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
): NodeMaterialBlock[] {
  const position = new InputBlock(
    `${name}_position`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector3,
  );
  position.setAsAttribute("position");
  const normal = new InputBlock(
    `${name}_normal`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector3,
  );
  normal.setAsAttribute("normal");
  const uv = new InputBlock(
    `${name}_uv`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector2,
  );
  uv.setAsAttribute("uv");

  const world = matrixInput(`${name}_world`, NodeMaterialSystemValues.World);
  const instances = new InstancesBlock(`${name}_instances`);
  world.output.connectTo(instances.world);
  const bones = new BonesBlock(`${name}_bones`);
  instances.output.connectTo(bones.world);
  const indicesExtra = new InputBlock(`${name}_indicesExtra`);
  indicesExtra.setAsAttribute("matricesIndicesExtra");
  indicesExtra.output.connectTo(bones.matricesIndicesExtra);
  const weightsExtra = new InputBlock(`${name}_weightsExtra`);
  weightsExtra.setAsAttribute("matricesWeightsExtra");
  weightsExtra.output.connectTo(bones.matricesWeightsExtra);
  const morph = new MorphTargetsBlock(`${name}_morphTargets`);
  position.output.connectTo(morph.position);
  normal.output.connectTo(morph.normal);
  uv.output.connectTo(morph.uv);
  const viewProjection = matrixInput(
    `${name}_viewProjection`,
    NodeMaterialSystemValues.ViewProjection,
  );
  const view = matrixInput(`${name}_view`, NodeMaterialSystemValues.View);
  const cameraPosition = new InputBlock(
    `${name}_cameraPosition`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector3,
  );
  cameraPosition.setAsSystemValue(NodeMaterialSystemValues.CameraPosition);

  const worldPosition = new TransformBlock(`${name}_worldPos`);
  morph.positionOutput.connectTo(worldPosition.vector);
  bones.output.connectTo(worldPosition.transform);

  const clipPosition = new TransformBlock(`${name}_clipPos`);
  viewProjection.output.connectTo(clipPosition.transform);

  const worldNormal = new TransformBlock(`${name}_worldNormal`);
  worldNormal.transformAsDirection = true;
  morph.normalOutput.connectTo(worldNormal.vector);
  bones.output.connectTo(worldNormal.transform);

  const viewDirection = new ViewDirectionBlock(`${name}_viewDirection`);
  worldPosition.output.connectTo(viewDirection.worldPosition);
  cameraPosition.output.connectTo(viewDirection.cameraPosition);

  const vertexOutput = new VertexOutputBlock(`${name}_vertexOutput`);
  clipPosition.output.connectTo(vertexOutput.vector);

  created.push(
    position,
    normal,
    uv,
    world,
    instances,
    bones,
    indicesExtra,
    weightsExtra,
    morph,
    viewProjection,
    view,
    cameraPosition,
    worldPosition,
    clipPosition,
    worldNormal,
    viewDirection,
    vertexOutput,
  );

  plumbing.worldPosition = worldPosition.output;
  plumbing.position = morph.positionOutput;
  plumbing.localNormal = morph.normalOutput;
  plumbing.world = bones.output;
  plumbing.localTangent = morph.tangentOutput;
  plumbing.clipPosition = clipPosition.vector;
  plumbing.worldNormal = worldNormal.xyz;
  plumbing.worldNormal4 = worldNormal.output;
  plumbing.cameraPosition = cameraPosition.output;
  plumbing.viewDirection = viewDirection.output;
  plumbing.uv = morph.uvOutput;
  plumbing.uv2 = morph.uv2Output;
  plumbing.view = view.output;
  return [vertexOutput];
}

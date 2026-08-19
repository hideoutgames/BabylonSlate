import {
  AddBlock,
  FragmentOutputBlock,
  InputBlock,
  Material,
  MultiplyBlock,
  NodeMaterial,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialModes,
  NodeMaterialSystemValues,
  PBRMetallicRoughnessBlock,
  RemapBlock,
  TransformBlock,
  VectorMergerBlock,
  VectorSplitterBlock,
  VertexOutputBlock,
  ViewDirectionBlock,
  type Mesh,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialOperand,
  MaterialOperation,
  MaterialValueType,
} from "@babylonslate/shader-graph";
import { materialNodeDefinition } from "@babylonslate/shader-graph";
import {
  blockAdapterFor,
  createConstantBlock,
  type BlockRealization,
  type MaterialPlumbing,
} from "./material-block-registry";
import { isDisposedGpuTexture } from "./gpu-resource-live";

export interface CompileMaterialOptions {
  scene: Scene;
  name: string;
  /** Texture asset guid to a live Babylon texture (through `ResourceCache`). */
  resolveTexture?: (guid: string) => Texture | null;
}

export interface CompiledMaterial {
  ok: true;
  material: NodeMaterial;
  /** Idempotent: disposes the material and every block it created. */
  dispose: () => void;
}

export interface FailedMaterial {
  ok: false;
  diagnostics: MaterialDiagnostic[];
}

export type CompileMaterialResult = CompiledMaterial | FailedMaterial;

/**
 * Explicit guard rather than a bare `result.ok` check: `apps/editor` compiles
 * these sources without `strictNullChecks`, where TypeScript does not narrow a
 * union by a boolean discriminant.
 */
export function materialCompileFailed(
  result: CompileMaterialResult,
): result is FailedMaterial {
  return result.ok === false;
}

/** Diagnostics anchor to the outermost call node so tapping one navigates. */
function anchorNodeId(operation: MaterialOperation): string {
  return operation.source.callPath[0] ?? operation.source.nodeId;
}

function colorPins(nodeType: string): Set<string> {
  return nodeType === "const.color" || nodeType === "param.color"
    ? new Set(["out"])
    : new Set();
}

/**
 * Compile a lowered plan into a real Babylon NodeMaterial.
 *
 * Every operation becomes one or more Babylon blocks with actual connections,
 * so editing the graph changes the generated shader. This never emits shader
 * source itself; portability comes from staying inside Babylon's block set.
 */
export function compileMaterialPlan(
  plan: MaterialBuildPlan,
  options: CompileMaterialOptions,
): CompileMaterialResult {
  const { scene } = options;
  const material = new NodeMaterial(options.name, scene);
  material.mode =
    plan.domain === "postProcess" || plan.domain === "interface"
      ? NodeMaterialModes.PostProcess
      : plan.domain === "particle"
        ? NodeMaterialModes.Particle
        : NodeMaterialModes.Material;

  const created: NodeMaterialBlock[] = [];
  const diagnostics: MaterialDiagnostic[] = [];
  const realized = new Map<string, BlockRealization>();
  const plumbing: MaterialPlumbing = {};
  const outputNodes: NodeMaterialBlock[] = [];

  const fail = (): CompileMaterialResult => {
    for (const block of created) block.dispose();
    material.dispose();
    return { ok: false, diagnostics };
  };

  const track = (realization: BlockRealization): BlockRealization => {
    created.push(...realization.blocks);
    return realization;
  };

  // Engine-owned plumbing must exist before operations so nodes such as World
  // Normal and Screen UV read the real transformed values.
  try {
    if (plan.domain === "postProcess" || plan.domain === "interface") {
      outputNodes.push(...createPostProcessPlumbing(options.name, created, plumbing));
      if (plan.domain === "interface") {
        plumbing.uv = plumbing.screenUv;
      }
    } else if (plan.domain !== "particle") {
      outputNodes.push(...createSurfacePlumbing(options.name, created, plumbing));
    }
  } catch (error) {
    diagnostics.push({
      code: "material.compile.plumbingFailed",
      message:
        error instanceof Error ? error.message : "Material plumbing failed",
      severity: "error",
    });
    return fail();
  }

  /** Materialise a constant literal as its own InputBlock. */
  const constantPoint = (
    type: MaterialValueType,
    value: readonly number[],
    name: string,
    asColor: boolean,
  ): NodeMaterialConnectionPoint => {
    const block = createConstantBlock(name, type, value, asColor);
    created.push(block);
    return block.output;
  };

  const pointForOperand = (
    operand: MaterialOperand,
    name: string,
    asColor: boolean,
  ): NodeMaterialConnectionPoint | null => {
    if (operand.kind === "constant") {
      return constantPoint(operand.type, operand.value, name, asColor);
    }
    const producer = realized.get(operand.operationId);
    if (!producer) return null;
    return producer.outputs[operand.pinId] ?? null;
  };

  const realizeOperation = (operation: MaterialOperation): boolean => {
    if (realized.has(operation.id)) return true;
    const isConstant =
      operation.nodeType.startsWith("const.") ||
      operation.nodeType.startsWith("param.");
    if (isConstant) {
      if (operation.nodeType === "param.texture") {
        // Texture parameters have no block of their own; the sampling node
        // owns the Babylon TextureBlock and reads the guid from here.
        realized.set(operation.id, { blocks: [], inputs: {}, outputs: {} });
        return true;
      }
      const value = Array.isArray(operation.properties.value)
        ? (operation.properties.value as number[])
        : [0];
      const definition = materialNodeDefinition(operation.nodeType);
      const pin = definition?.outputs[0];
      const asColor = pin?.colorHint === true;
      // Take the width from the catalog so a Color constant stays whatever the
      // pin declares rather than being forced to four components.
      const type =
        pin && pin.type.kind !== "generic"
          ? (pin.type.kind as MaterialValueType)
          : "float";
      const block = createConstantBlock(operation.id, type, value, asColor);
      created.push(block);
      realized.set(operation.id, {
        blocks: [block],
        inputs: {},
        outputs: { out: block.output },
      });
      return true;
    }

    const adapter = blockAdapterFor(operation.nodeType);
    if (!adapter) {
      diagnostics.push({
        code: "material.compile.unsupportedNode",
        message: `No Babylon block is registered for "${operation.nodeType}"`,
        severity: "error",
        nodeId: anchorNodeId(operation),
      });
      return false;
    }
    if (operation.nodeType === "custom.glsl" && scene.getEngine().isWebGPU) {
      diagnostics.push({
        code: "material.capability",
        message: "Custom GLSL is GLSL/WebGL only and cannot run on WebGPU",
        severity: "error",
        nodeId: anchorNodeId(operation),
      });
      return false;
    }

    let realization: BlockRealization;
    try {
      realization = track(
        adapter({
          operation,
          name: operation.id.replace(/[^A-Za-z0-9_]/g, "_"),
          resolveTexture: options.resolveTexture,
          plumbing,
        }),
      );
    } catch (error) {
      diagnostics.push({
        code: "material.compile.blockFailed",
        message: `"${operation.nodeType}" failed to build: ${
          error instanceof Error ? error.message : String(error)
        }`,
        severity: "error",
        nodeId: anchorNodeId(operation),
      });
      return false;
    }
    realized.set(operation.id, realization);

    if (
      operation.nodeType === "texture.sample" ||
      operation.nodeType === "texture.sampleLod"
    ) {
      if (!bindTexture(operation, plan, realization, options, diagnostics)) {
        return false;
      }
    }

    const colored = colorPins(operation.nodeType);
    for (const [pinId, operand] of Object.entries(operation.inputs)) {
      const target = realization.inputs[pinId];
      if (!target) continue;
      const point = pointForOperand(
        operand,
        `${operation.id}_${pinId}`.replace(/[^A-Za-z0-9_]/g, "_"),
        colored.has(pinId),
      );
      if (!point) continue;
      try {
        point.connectTo(target);
      } catch (error) {
        diagnostics.push({
          code: "material.compile.connectionFailed",
          message: `"${operation.nodeType}" could not accept "${pinId}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          severity: "error",
          nodeId: anchorNodeId(operation),
          pinId,
        });
        return false;
      }
    }

    const uvTarget = realization.inputs.uv;
    const uvFallback = plumbing.uv ?? plumbing.screenUv;
    if (uvTarget && !uvTarget.isConnected && uvFallback) {
      try {
        uvFallback.connectTo(uvTarget);
      } catch (error) {
        diagnostics.push({
          code: "material.compile.connectionFailed",
          message: `"${operation.nodeType}" could not accept "uv": ${
            error instanceof Error ? error.message : String(error)
          }`,
          severity: "error",
          nodeId: anchorNodeId(operation),
          pinId: "uv",
        });
        return false;
      }
    }
    return true;
  };

  const realizeOperations = (ids?: ReadonlySet<string>): boolean => {
    for (const operation of plan.operations) {
      if (ids && !ids.has(operation.id)) continue;
      if (!realizeOperation(operation)) return false;
    }
    return true;
  };

  if (plan.domain === "surface") {
    const vertexIds = collectWorldPositionOffsetOperationIds(plan);
    if (!realizeOperations(vertexIds)) return fail();
    const offsetOperand = plan.outputs.worldPositionOffset ?? null;
    if (!isIdentityWorldPositionOffset(offsetOperand) && offsetOperand) {
      const offset = pointForOperand(
        offsetOperand,
        `${options.name}_worldPositionOffset`,
        false,
      );
      if (offset) {
        applyWorldPositionOffset(options.name, created, plumbing, offset);
      }
    }
    if (!realizeOperations()) return fail();
    if (plumbing.clipPosition && plumbing.worldPosition) {
      plumbing.worldPosition.connectTo(plumbing.clipPosition);
    }
  } else if (!realizeOperations()) {
    return fail();
  }

  if (plan.domain === "particle") {
    ensureParticleTextureUvs(options.name, created);
  }

  const outputPoint = (
    pinId: string,
    name: string,
    asColor: boolean,
  ): NodeMaterialConnectionPoint | null => {
    const operand = plan.outputs[pinId];
    if (!operand) return null;
    return pointForOperand(operand, name, asColor);
  };

  try {
    if (plan.domain === "postProcess" || plan.domain === "particle") {
      const fragment = new FragmentOutputBlock(`${options.name}_fragment`);
      created.push(fragment);
      const color = outputPoint("color", `${options.name}_color`, true);
      if (color) color.connectTo(fragment.rgba);
      outputNodes.push(fragment);
    } else if (plan.domain === "interface") {
      outputNodes.push(
        attachInterfaceShading(options, created, outputPoint),
      );
    } else {
      outputNodes.push(
        attachSurfaceShading(plan, options, created, plumbing, outputPoint),
      );
    }
    for (const node of outputNodes) material.addOutputNode(node);
  } catch (error) {
    diagnostics.push({
      code: "material.compile.buildFailed",
      message:
        error instanceof Error ? error.message : "Material failed to build",
      severity: "error",
    });
    return fail();
  }

  // Babylon reports build failures through an observable rather than throwing,
  // so a silent failure would otherwise look like a successful compile.
  let buildError: string | null = null;
  const errorObserver = material.onBuildErrorObservable.add((message) => {
    buildError = message;
  });
  try {
    material.build();
  } catch (error) {
    buildError =
      error instanceof Error ? error.message : "Material failed to build";
  } finally {
    material.onBuildErrorObservable.remove(errorObserver);
  }
  if (buildError !== null) {
    diagnostics.push({
      code: "material.compile.buildFailed",
      message: buildError,
      severity: "error",
    });
    return fail();
  }

  applyAuthoredSurfaceBlend(material, plan);

  let disposed = false;
  return {
    ok: true,
    material,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      material.dispose();
    },
  };
}

/** NodeMaterial has no typed `alphaCutOff`; StandardMaterial / PBR do. */
type MaterialAlphaCutOff = { alphaCutOff: number };

function applyAlphaCutOff(material: Material, cutoff: number): void {
  (material as Material & MaterialAlphaCutOff).alphaCutOff = cutoff;
}

/** Map authored blend / two-sided onto Babylon after `material.build()`. */
function applyAuthoredSurfaceBlend(
  material: NodeMaterial,
  plan: MaterialBuildPlan,
): void {
  if (
    plan.domain === "postProcess" ||
    plan.domain === "interface" ||
    plan.domain === "particle"
  ) {
    return;
  }
  material.backFaceCulling = plan.twoSided !== true;
  material.needDepthPrePass = false;
  switch (plan.blendMode) {
    case "masked":
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      applyAlphaCutOff(material, plan.alphaCutoff);
      return;
    case "translucent":
    case "additive":
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.needDepthPrePass = true;
      return;
    default:
      material.transparencyMode = Material.MATERIAL_OPAQUE;
  }
}

/** Prefer a wired `param.texture`; otherwise use the sample's inline asset. */
function bindTexture(
  operation: MaterialOperation,
  plan: MaterialBuildPlan,
  realization: BlockRealization,
  options: CompileMaterialOptions,
  diagnostics: MaterialDiagnostic[],
): boolean {
  const operand = operation.inputs.texture;
  const producerId =
    operand?.kind === "operation" ? operand.operationId : undefined;
  const binding =
    plan.textures.find((entry) => entry.operationId === producerId) ??
    plan.textures.find((entry) => entry.operationId === operation.id);
  if (!binding) return true;
  const texture = options.resolveTexture?.(binding.textureGuid) ?? null;
  if (!texture || isDisposedGpuTexture(texture)) {
    diagnostics.push({
      code: "material.missingTexture",
      message: `Texture "${binding.textureGuid}" could not be loaded`,
      severity: "error",
      nodeId: anchorNodeId(operation),
    });
    return false;
  }
  const block = realization.blocks[0] as unknown as {
    texture?: Texture | null;
  };
  block.texture = texture;
  return true;
}

/** ParticleTextureBlock requires UV; live systems supply `particle_uv`. */
function ensureParticleTextureUvs(
  name: string,
  created: NodeMaterialBlock[],
): void {
  const extra: NodeMaterialBlock[] = [];
  for (const block of created) {
    if (!(block instanceof ParticleTextureBlock)) continue;
    if (block.uv.isConnected) continue;
    const uv = new InputBlock(
      `${name}_${block.name}_particleUv`.replace(/[^A-Za-z0-9_]/g, "_"),
      undefined,
      NodeMaterialBlockConnectionPointTypes.Vector2,
    );
    uv.setAsAttribute("particle_uv");
    uv.output.connectTo(block.uv);
    extra.push(uv);
  }
  created.push(...extra);
}

function matrixInput(
  name: string,
  systemValue: NodeMaterialSystemValues,
): InputBlock {
  const block = new InputBlock(
    name,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Matrix,
  );
  block.setAsSystemValue(systemValue);
  return block;
}

function collectWorldPositionOffsetOperationIds(
  plan: MaterialBuildPlan,
): Set<string> {
  const ids = new Set<string>();
  const visit = (operand: MaterialOperand | null | undefined): void => {
    if (!operand || operand.kind !== "operation") return;
    if (ids.has(operand.operationId)) return;
    ids.add(operand.operationId);
    const operation = plan.operations.find(
      (entry) => entry.id === operand.operationId,
    );
    if (!operation) return;
    for (const input of Object.values(operation.inputs)) {
      visit(input);
    }
  };
  visit(plan.outputs.worldPositionOffset);
  return ids;
}

function isIdentityWorldPositionOffset(
  operand: MaterialOperand | null,
): boolean {
  if (!operand) return true;
  if (operand.kind !== "constant") return false;
  return operand.value.every((component) => component === 0);
}

/**
 * Add an authored world-space vec3 to the plumbed world position, then keep w.
 * Clip and PBR read the updated plumbing tap; graph World Position nodes that
 * already compiled still see the pre-offset position.
 */
function applyWorldPositionOffset(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
  offset: NodeMaterialConnectionPoint,
): void {
  if (!plumbing.worldPosition) return;
  const split = new VectorSplitterBlock(`${name}_worldPosSplit`);
  plumbing.worldPosition.connectTo(split.xyzw);
  const add = new AddBlock(`${name}_worldPosOffset`);
  split.xyzOut.connectTo(add.left);
  offset.connectTo(add.right);
  const merge = new VectorMergerBlock(`${name}_worldPosDisplaced`);
  add.output.connectTo(merge.xyzIn);
  split.w.connectTo(merge.w);
  created.push(split, add, merge);
  plumbing.worldPosition = merge.xyzw;
}

/**
 * Vertex transform and world-space geometry every surface material needs.
 * Returns the vertex output node the material must own.
 */
function createSurfacePlumbing(
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
  position.output.connectTo(worldPosition.vector);
  world.output.connectTo(worldPosition.transform);

  const clipPosition = new TransformBlock(`${name}_clipPos`);
  viewProjection.output.connectTo(clipPosition.transform);

  const worldNormal = new TransformBlock(`${name}_worldNormal`);
  worldNormal.transformAsDirection = true;
  normal.output.connectTo(worldNormal.vector);
  world.output.connectTo(worldNormal.transform);

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
  plumbing.clipPosition = clipPosition.vector;
  plumbing.worldNormal = worldNormal.xyz;
  plumbing.worldNormal4 = worldNormal.output;
  plumbing.cameraPosition = cameraPosition.output;
  plumbing.viewDirection = viewDirection.output;
  plumbing.uv = uv.output;
  plumbing.view = view.output;
  return [vertexOutput];
}

/**
 * A post-process material still needs a vertex program: Babylon draws a
 * fullscreen quad from the `position2d` attribute, and the screen UV is that
 * position remapped from clip space into 0..1.
 */
function createPostProcessPlumbing(
  name: string,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
): NodeMaterialBlock[] {
  const position = new InputBlock(
    `${name}_position2d`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector2,
  );
  position.setAsAttribute("position2d");

  const one = new InputBlock(
    `${name}_one`,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Float,
  );
  one.isConstant = true;
  one.value = 1;

  const merger = new VectorMergerBlock(`${name}_position3d`);
  position.output.connectTo(merger.xyIn);
  one.output.connectTo(merger.w);

  const vertexOutput = new VertexOutputBlock(`${name}_vertexOutput`);
  merger.xyzw.connectTo(vertexOutput.vector);

  const screenUv = new RemapBlock(`${name}_screenUv`);
  position.output.connectTo(screenUv.input);

  created.push(position, one, merger, vertexOutput, screenUv);
  plumbing.screenUv = screenUv.output;
  return [vertexOutput];
}

/**
 * Unlit 2D fragment: authored Color (vec4) with Opacity multiplying alpha.
 * Reuses the post-process quad; never the PBR shading block.
 */
function attachInterfaceShading(
  options: CompileMaterialOptions,
  created: NodeMaterialBlock[],
  outputPoint: (
    pinId: string,
    name: string,
    asColor: boolean,
  ) => NodeMaterialConnectionPoint | null,
): NodeMaterialBlock {
  const fragment = new FragmentOutputBlock(`${options.name}_fragment`);
  created.push(fragment);
  const color = outputPoint("color", `${options.name}_color`, true);
  const opacity = outputPoint("opacity", `${options.name}_opacity`, false);
  if (color && opacity) {
    const split = new VectorSplitterBlock(`${options.name}_ifaceSplit`);
    color.connectTo(split.xyzw);
    const mul = new MultiplyBlock(`${options.name}_ifaceOpacity`);
    split.w.connectTo(mul.left);
    opacity.connectTo(mul.right);
    const merge = new VectorMergerBlock(`${options.name}_ifaceRgba`);
    split.xyzOut.connectTo(merge.xyzIn);
    mul.output.connectTo(merge.w);
    created.push(split, mul, merge);
    merge.xyzw.connectTo(fragment.rgba);
  } else if (color) {
    color.connectTo(fragment.rgba);
  }
  return fragment;
}

/**
 * Wire the authored surface channels into either the PBR shading block or a
 * direct fragment write for unlit materials.
 */
function attachSurfaceShading(
  plan: MaterialBuildPlan,
  options: CompileMaterialOptions,
  created: NodeMaterialBlock[],
  plumbing: MaterialPlumbing,
  outputPoint: (
    pinId: string,
    name: string,
    asColor: boolean,
  ) => NodeMaterialConnectionPoint | null,
): NodeMaterialBlock {
  const fragment = new FragmentOutputBlock(`${options.name}_fragment`);
  created.push(fragment);

  const baseColor = outputPoint("baseColor", `${options.name}_baseColor`, true);

  if (plan.shadingModel === "unlit") {
    if (baseColor) baseColor.connectTo(fragment.rgb);
    const opacity = outputPoint("opacity", `${options.name}_opacity`, false);
    if (opacity) opacity.connectTo(fragment.a);
    return fragment;
  }

  const pbr = new PBRMetallicRoughnessBlock(`${options.name}_pbr`);
  created.push(pbr);
  plumbing.worldPosition?.connectTo(pbr.worldPosition);
  plumbing.worldNormal4?.connectTo(pbr.worldNormal);
  plumbing.view?.connectTo(pbr.view);
  plumbing.cameraPosition?.connectTo(pbr.cameraPosition);

  if (baseColor) {
    baseColor.connectTo(pbr.baseColor);
  } else {
    const fallback = createConstantBlock(
      `${options.name}_baseColorFallback`,
      "vec3",
      [0.8, 0.8, 0.8],
      true,
    );
    created.push(fallback);
    fallback.output.connectTo(pbr.baseColor);
  }
  const metallic = outputPoint("metallic", `${options.name}_metallic`, false);
  if (metallic) metallic.connectTo(pbr.metallic);
  const roughness = outputPoint("roughness", `${options.name}_roughness`, false);
  if (roughness) roughness.connectTo(pbr.roughness);
  const normal = outputPoint("normal", `${options.name}_normalInput`, false);
  if (normal) {
    // PBR registers a Vector 4 perturbed normal; the authored channel is a
    // Vector 3 direction, so widen it with a zero w.
    const widen = new VectorMergerBlock(`${options.name}_normalWiden`);
    created.push(widen);
    normal.connectTo(widen.xyzIn);
    widen.xyzw.connectTo(pbr.perturbedNormal);
  }
  const opacity = outputPoint("opacity", `${options.name}_opacity`, false);
  if (opacity) opacity.connectTo(pbr.opacity);

  pbr.lighting.connectTo(fragment.rgb);
  return fragment;
}

/**
 * Pre-warm a compiled material so the first draw does not stall.
 * Surface materials compile against the mesh they will actually be drawn with.
 */
export async function prewarmMaterial(
  material: NodeMaterial,
  mesh: Mesh | null,
): Promise<void> {
  if (!mesh) return;
  if (material.mode === NodeMaterialModes.Particle) return;
  await material.forceCompilationAsync(mesh);
}

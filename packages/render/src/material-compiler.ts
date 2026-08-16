import {
  FragmentOutputBlock,
  InputBlock,
  NodeMaterial,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialModes,
  NodeMaterialSystemValues,
  PBRMetallicRoughnessBlock,
  RemapBlock,
  TransformBlock,
  VectorMergerBlock,
  VertexOutputBlock,
  ViewDirectionBlock,
  type Mesh,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialOperand,
  MaterialOperation,
  MaterialValueType,
} from "@babylonslate/shader-graph";
import {
  blockAdapterFor,
  createConstantBlock,
  type BlockRealization,
  type MaterialPlumbing,
} from "./material-block-registry";

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
    plan.domain === "postProcess"
      ? NodeMaterialModes.PostProcess
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
    if (plan.domain === "postProcess") {
      outputNodes.push(...createPostProcessPlumbing(options.name, created, plumbing));
    } else {
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

  for (const operation of plan.operations) {
    const isConstant =
      operation.nodeType.startsWith("const.") ||
      operation.nodeType.startsWith("param.");
    if (isConstant) {
      if (operation.nodeType === "param.texture") {
        // Texture parameters have no block of their own; the sampling node
        // owns the Babylon TextureBlock and reads the guid from here.
        realized.set(operation.id, { blocks: [], inputs: {}, outputs: {} });
        continue;
      }
      const value = Array.isArray(operation.properties.value)
        ? (operation.properties.value as number[])
        : [0];
      const asColor = operation.nodeType.endsWith("color");
      const type = asColor
        ? operation.nodeType === "param.color"
          ? "vec4"
          : "vec4"
        : constantTypeFor(operation.nodeType);
      const block = createConstantBlock(operation.id, type, value, asColor);
      created.push(block);
      realized.set(operation.id, {
        blocks: [block],
        inputs: {},
        outputs: { out: block.output },
      });
      continue;
    }

    const adapter = blockAdapterFor(operation.nodeType);
    if (!adapter) {
      diagnostics.push({
        code: "material.compile.unsupportedNode",
        message: `No Babylon block is registered for "${operation.nodeType}"`,
        severity: "error",
        nodeId: anchorNodeId(operation),
      });
      return fail();
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
      return fail();
    }
    realized.set(operation.id, realization);

    if (
      operation.nodeType === "texture.sample" ||
      operation.nodeType === "texture.sampleLod"
    ) {
      bindTexture(operation, plan, realization, options);
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
        return fail();
      }
    }
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
    if (plan.domain === "postProcess") {
      const fragment = new FragmentOutputBlock(`${options.name}_fragment`);
      created.push(fragment);
      const color = outputPoint("color", `${options.name}_color`, true);
      if (color) color.connectTo(fragment.rgba);
      outputNodes.push(fragment);
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

function constantTypeFor(nodeType: string): MaterialValueType {
  switch (nodeType) {
    case "const.vec2":
      return "vec2";
    case "const.vec3":
      return "vec3";
    case "const.vec4":
      return "vec4";
    default:
      return "float";
  }
}

/** A texture sample reads its guid from the `param.texture` node feeding it. */
function bindTexture(
  operation: MaterialOperation,
  plan: MaterialBuildPlan,
  realization: BlockRealization,
  options: CompileMaterialOptions,
): void {
  const operand = operation.inputs.texture;
  const producerId =
    operand?.kind === "operation" ? operand.operationId : undefined;
  const binding = plan.textures.find(
    (entry) => entry.operationId === producerId,
  );
  if (!binding) return;
  const texture = options.resolveTexture?.(binding.textureGuid) ?? null;
  const block = realization.blocks[0] as unknown as {
    texture?: Texture | null;
  };
  if (texture) block.texture = texture;
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
  worldPosition.output.connectTo(clipPosition.vector);
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
  await material.forceCompilationAsync(mesh);
}

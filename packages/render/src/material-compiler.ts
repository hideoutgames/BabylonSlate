import { registerClusteredSurfaceMaterial } from "./clustered-material-policy";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";
import {
  AddBlock,
  BonesBlock,
  ClampBlock,
  InstancesBlock,
  MorphTargetsBlock,
  Constants,
  DiscardBlock,
  FragmentOutputBlock,
  ImageProcessingBlock,
  InputBlock,
  Material,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  NodeMaterial,
  ShaderLanguage,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialModes,
  NodeMaterialSystemValues,
  RemapBlock,
  ScaleBlock,
  TransformBlock,
  TextureBlock,
  VectorMergerBlock,
  Vector3,
  VectorSplitterBlock,
  VertexOutputBlock,
  ViewDirectionBlock,
  type Effect,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
  type NodeMaterialDefines,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { ImageSourceBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/imageSourceBlock";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialOperand,
  MaterialOperation,
  MaterialValueType,
} from "@babylonslate/shader-graph";
import { componentCount, materialNodeDefinition } from "@babylonslate/shader-graph";
import { materialGlslDiagnostic } from "./material-glsl-diagnostics";
import {
  blockAdapterFor,
  createConstantBlock,
  type BlockRealization,
  type MaterialPlumbing,
} from "./material-block-registry";
import {
  isDisposedGpuTexture,
  isDisposedNodeMaterial,
  isEngineOwnedGpuTexture,
} from "./gpu-resource-live";
import { OwnedPostProcess } from "./owned-post-process";
import { PostProcessRetirement } from "./post-process-retirement";
import { createMaterialParameterBindings } from "./material-parameters";
import { syncSceneLighting } from "./scene-lighting";
import { installCelSurface } from "./cel-surface";
import { retainEnvironmentSample } from "./environment-lighting";
import { EnvironmentSampleBlock } from "./environment-sample-block";
import { SceneReflectionBlock } from "./scene-reflection-block";
import { FlatNormalBlock } from "./flat-normal-block";
import { GeometrySurfaceOutputBlock, connectGeometrySurfaceOutput } from "./geometry-surface-output-block";
import { ScenePbrLightingBlock } from "./scene-pbr-lighting-block";
import { registerCacheableShadowMaterial } from "./shadow-material-policy";
import { prepareNodeMaterialParticleBindings } from "./node-material-particles";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import { SharedOutlineIdentityBlock, SharedOutlineOutputBlock } from "./shared-outline-output-block";

export interface CompileMaterialOptions {
  /** Internal coverage variant; retains authored deformation and alpha discard. */
  surfaceVariant?: "outlineMask";
  /** Internal FrameGraph variant; shared resources are bound by its render pass. */
  logicalSceneBuffers?: boolean;
  /** Editor-only single-quad preview; live particle systems retain Particle mode. */
  particlePreview?: boolean;
  scene: Scene;
  name: string;
  /** Texture asset guid to a live Babylon texture (through `ResourceCache`). */
  resolveTexture?: (guid: string) => Texture | null;
  /** Packed KTX2 / raster decode failure after the first `build()`. */
  onTextureError?: (diagnostic: MaterialDiagnostic) => void;
}

export interface CompiledMaterial {
  ok: true;
  material: NodeMaterial;
  /** Assembly succeeded. Await ready before publishing the material. */
  ready: Promise<readonly MaterialDiagnostic[]>;
  readonly buildState: "pending" | "ready" | "failed";
  setParameter: (name: string, parameter: MaterialParameterValue) => boolean;
  getParameter: (name: string) => MaterialParameterValue | null;
  resetParameter: (name: string) => boolean;
  /** Idempotent: disposes the material and every block it created. */
  dispose: () => void;
  /**
   * Confirmed native release of the material's owned compile-time passes.
   * Disposes the material if needed, then resolves once the underlying
   * NodeMaterial is actually released; rejects if release never confirmed.
   */
  whenReleased: () => Promise<void>;
}

export interface FailedMaterial {
  ok: false;
  diagnostics: MaterialDiagnostic[];
}

export type CompileMaterialResult = CompiledMaterial | FailedMaterial;

const materialBuilds = new WeakMap<NodeMaterial, Promise<readonly MaterialDiagnostic[]>>();
export interface AuthoredOutlineVariant {
  compiled: CompiledMaterial;
  /** Release after the caller's pass DrawWrappers have released their Effects. */
  release: () => Promise<void>;
}
const authoredOutlineFactories = new WeakMap<Material, () => AuthoredOutlineVariant>();
/** Only compiler-owned material generations have reproducible authored coverage. */
export function acquireAuthoredOutlineVariant(source: Material): AuthoredOutlineVariant | undefined {
  return authoredOutlineFactories.get(source)?.();
}

function isEngineErrorSampler(texture: Texture): boolean {
  const engine =
    texture.getScene()?.getEngine() ??
    (
      texture as Texture & {
        _engine?: { emptyTexture?: unknown };
      }
    )._engine;
  const internal = texture.getInternalTexture();
  if (!engine || !internal) return false;
  return internal === engine.emptyTexture;
}

/** True when a TextureBlock can sample authored texels, not Babylon's error sampler. */
export function isGpuTextureSampleReady(texture: Texture): boolean {
  if (texture.loadingError) return false;
  if (!texture.isReady()) return false;
  return !isEngineErrorSampler(texture);
}

export function nodeMaterialTexturesSampleReady(
  material: NodeMaterial,
): boolean {
  for (const block of material.attachedBlocks) {
    if (block instanceof EnvironmentSampleBlock && !block.isReady()) return false;
    const textured = block as { texture?: Texture | null };
    if (!textured.texture) continue;
    if (!isGpuTextureSampleReady(textured.texture)) return false;
  }
  return true;
}

function markCompiledMaterialDirty(material: NodeMaterial): void {
  const scene = material.getScene();
  const blocked = scene.blockMaterialDirtyMechanism;
  scene.blockMaterialDirtyMechanism = false;
  try {
    material.markDirty();
  } finally {
    scene.blockMaterialDirtyMechanism = blocked;
  }
}

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

/** Babylon removes digits before allocating unique shader symbols. Collapse the
 * separators after that removal so generated node IDs cannot introduce GLSL's
 * reserved double underscore, including when an adapter appends a suffix. */
function operationBlockName(id: string): string {
  const name = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/[0-9]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return !name || name.startsWith("gl_") ? `slate_${name || "node"}` : name;
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
  const outlineMask = options.surfaceVariant === "outlineMask";
  const cacheableShadowShape = !outlineMask && plan.domain === "surface" && plan.blendMode === "opaque" &&
    plan.cost.customBlocks === 0 && isIdentityWorldPositionOffset(plan.outputs.worldPositionOffset ?? null);
  const material = new NodeMaterial(options.name, scene, {
    shaderLanguage: scene.getEngine().isWebGPU
      ? ShaderLanguage.WGSL
      : ShaderLanguage.GLSL,
  });
  if (scene.getEngine().isWebGPU) rebindEmptiedDrawContexts(material);
  material.metadata = { boundsPadding: plan.boundsPadding ?? 0 };
  const configureSurface = () => {
    if (outlineMask) {
      material.backFaceCulling = plan.twoSided !== true;
      material.transparencyMode = Material.MATERIAL_OPAQUE;
      material.alphaMode = Constants.ALPHA_DISABLE;
    } else { applyAuthoredSurfaceBlend(material, plan); syncSceneLighting(scene); }
  };
  material.mode =
    plan.domain === "postProcess"
      ? NodeMaterialModes.PostProcess
      : plan.domain === "particle" && !options.particlePreview
        ? NodeMaterialModes.Particle
        : NodeMaterialModes.Material;

  const created: NodeMaterialBlock[] = [];
  const pendingTextures: Texture[] = [];
  const diagnostics: MaterialDiagnostic[] = [];
  const realized = new Map<string, BlockRealization>();
  const plumbing: MaterialPlumbing = { particlePreview: plan.domain === "particle" && options.particlePreview,
    logicalSceneBuffers: plan.domain === "postProcess" && options.logicalSceneBuffers };
  if (plan.operations.some((operation) => operation.nodeType === "input.worldPosition" || operation.nodeType === "input.cameraPosition")) {
    const origin = new InputBlock("slateFloatingOrigin", undefined, NodeMaterialBlockConnectionPointTypes.Vector3);
    const zero = Vector3.Zero();
    origin.valueCallback = () => scene.floatingOriginMode ? scene.floatingOriginOffset : zero;
    plumbing.worldOrigin = origin.output;
    created.push(origin);
  }
  const outputNodes: NodeMaterialBlock[] = [];

  const fail = (): CompileMaterialResult => {
    for (const block of created) block.dispose();
    detachEngineOwnedTextures(material);
    material.dispose(false, false);
    return { ok: false, diagnostics };
  };

  const track = (realization: BlockRealization): BlockRealization => {
    created.push(...realization.blocks);
    return realization;
  };

  // Engine-owned plumbing must exist before operations so nodes such as World
  // Normal and Screen UV read the real transformed values.
  try {
    if (material.mode === NodeMaterialModes.Particle) {
      prepareNodeMaterialParticleBindings(material);
      const uv = new InputBlock(`${options.name}_particleUv`, undefined, NodeMaterialBlockConnectionPointTypes.Vector2);
      uv.setAsAttribute("particle_uv");
      created.push(uv);
      plumbing.uv = uv.output;
    }
    if (plan.domain === "postProcess") {
      outputNodes.push(
        ...createPostProcessPlumbing(options.name, created, plumbing),
      );
    } else if (plan.domain !== "particle" || options.particlePreview) {
      outputNodes.push(
        ...createSurfacePlumbing(options.name, created, plumbing),
      );
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

  const convertedPoints = new Map<string, NodeMaterialConnectionPoint>();
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
    let point = producer.outputs[operand.pinId];
    if (!point) return null;
    if (!operand.conversions?.length) return point;
    const key = JSON.stringify([operand.operationId, operand.pinId, operand.conversions]);
    const cached = convertedPoints.get(key);
    if (cached) return cached;
    for (const [index, conversion] of operand.conversions.entries()) {
      const blockName = operationBlockName(`${name}_resize${index}`);
      if (componentCount(conversion.from) < componentCount(conversion.to)) {
        const merge = new VectorMergerBlock(blockName);
        created.push(merge);
        point.connectTo(conversion.from === "float" ? merge.x : conversion.from === "vec2" ? merge.xyIn : merge.xyzIn);
        const padding = constantPoint("float", [1], `${blockName}_padding`, false);
        const channels = [merge.x, merge.y, merge.z, merge.w];
        for (const channel of channels.slice(componentCount(conversion.from), componentCount(conversion.to))) {
          padding.connectTo(channel);
        }
        point = conversion.to === "vec2" ? merge.xyOut : conversion.to === "vec3" ? merge.xyzOut : merge.xyzw;
      } else {
        const split = new VectorSplitterBlock(blockName);
        created.push(split);
        point.connectTo(conversion.from === "vec2" ? split.xyIn : conversion.from === "vec3" ? split.xyzIn : split.xyzw);
        point = conversion.to === "float" ? split.x : conversion.to === "vec2" ? split.xyOut : split.xyzOut;
      }
    }
    convertedPoints.set(key, point);
    return point;
  };

  const realizeOperation = (operation: MaterialOperation): boolean => {
    if (realized.has(operation.id)) return true;
    const isConstant =
      operation.nodeType.startsWith("const.") ||
      operation.nodeType.startsWith("param.");
    if (isConstant) {
      if (operation.nodeType === "param.texture") {
        const block = new ImageSourceBlock(operation.id);
        created.push(block);
        const realization = { blocks: [block], inputs: {}, outputs: { out: block.source } };
        realized.set(operation.id, realization);
        return bindTexture(operation, plan, realization, options, diagnostics, pendingTextures);
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
      const block = createConstantBlock(operationBlockName(operation.id), type, value, asColor);
      created.push(block);
      const blocks: NodeMaterialBlock[] = [block];
      const outputs: Record<string, NodeMaterialConnectionPoint> = {
        out: block.output,
      };
      if (operation.nodeType === "param.color") {
        const split = new VectorSplitterBlock(`${operation.id}_rgb`);
        block.output.connectTo(split.xyzw);
        created.push(split);
        blocks.push(split);
        outputs.rgb = split.xyzOut;
      }
      realized.set(operation.id, {
        blocks,
        inputs: {},
        outputs,
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
    if (operation.nodeType === "input.environmentSample" && !scene.getEngine().isWebGPU && !scene.getEngine().getCaps().textureLOD) {
      diagnostics.push({ code: "material.capability", message: "Environment Sample requires explicit cube mip sampling (WebGL2 or WebGPU).", severity: "error", nodeId: anchorNodeId(operation) });
      return false;
    }

    let realization: BlockRealization;
    try {
      realization = track(
        adapter({
          operation,
          name: operationBlockName(operation.id),
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
      (operation.nodeType === "texture.sample" ||
      operation.nodeType === "texture.sampleLod") && !operation.inputs.texture
    ) {
      if (
        !bindTexture(
          operation,
          plan,
          realization,
          options,
          diagnostics,
          pendingTextures,
        )
      ) {
        return false;
      }
    }

    const colored = colorPins(operation.nodeType);
    for (const [pinId, operand] of Object.entries(operation.inputs)) {
      const target = realization.inputs[pinId];
      if (!target) continue;
      try {
        const point = pointForOperand(
          operand,
          operationBlockName(`${operation.id}_${pinId}`),
          colored.has(pinId),
        );
        if (!point) continue;
        point.connectTo(target);
        if (pinId === "texture" && (operation.nodeType === "texture.sample" || operation.nodeType === "texture.sampleLod")) {
          realization.outputs.textureOut = point;
        }
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

  if (plan.domain === "particle" && options.particlePreview) {
    plumbing.worldPosition?.connectTo(plumbing.clipPosition!);
    material.backFaceCulling = false;
  }
  if (plan.domain === "particle" && !options.particlePreview) {
    ensureParticleTextureUvs(options.name, created);
  }

  let flatNormal: FlatNormalBlock | undefined;
  const outputPoint = (
    pinId: string,
    name: string,
    asColor: boolean,
  ): NodeMaterialConnectionPoint | null => {
    const operand = plan.outputs[pinId];
    if (!operand && pinId === "normal" && plan.defaultNormals === "flat") {
      if (!flatNormal && plumbing.worldPosition && plumbing.worldNormal) {
        flatNormal = new FlatNormalBlock(`${options.name}_flatNormal`);
        created.push(flatNormal);
        plumbing.worldPosition.connectTo(flatNormal.worldPosition);
        plumbing.worldNormal.connectTo(flatNormal.modelNormal);
      }
      return flatNormal?.output ?? null;
    }
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
    } else {
      if (outlineMask) {
        const identity = new SharedOutlineIdentityBlock(`${options.name}_identity`);
        const output = new SharedOutlineOutputBlock(`${options.name}_outline`);
        identity.identity.connectTo(output.rgb);
        if (plan.blendMode === "translucent" || plan.blendMode === "additive")
          outputPoint("opacity", `${options.name}_opacity`, false)?.connectTo(output.a);
        created.push(identity, output); outputNodes.push(output);
      } else outputNodes.push(attachSurfaceShading(plan, options, created, plumbing, outputPoint));
      if (plan.blendMode === "masked") {
        const discard = new DiscardBlock(`${options.name}_alphaClip`);
        const cutoff = createConstantBlock(`${options.name}_alphaCutoff`, "float", [plan.alphaCutoff]);
        const mask = outputPoint(plan.outputs.alphaClip ? "alphaClip" : "opacity", `${options.name}_clipMask`, false);
        mask?.connectTo(discard.value);
        cutoff.output.connectTo(discard.cutoff);
        created.push(discard, cutoff);
        outputNodes.push(discard);
      }
    }
    for (const node of outputNodes) material.addOutputNode(node);
    if (plan.domain === "surface" && !outlineMask) {
      const surface = outputNodes.find((node) => node instanceof FragmentOutputBlock);
      if (surface) installCelSurface(material, plan, surface, created, plumbing, outputPoint);
    }
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
  let buildState: CompiledMaterial["buildState"] = "pending";
  let disposed = false;
  let checkingShader = false;
  let shaderTimer: ReturnType<typeof setTimeout> | undefined;
  let shaderProbe: Mesh | null = null;
  let failedShaderEffect: Effect | null = null;
  material.onError = (effect) => { failedShaderEffect = effect; };
  let shaderPostProcess: OwnedPostProcess | null = null;
  let shaderParticles: ParticleSystem | null = null;
  const shaderRetirement = new PostProcessRetirement();
  const finishShaderCheck = () => {
    if (shaderTimer !== undefined) clearTimeout(shaderTimer);
    shaderProbe?.dispose();
    if (shaderPostProcess) {
      const pass = shaderPostProcess;
      shaderPostProcess = null;
      try {
        pass.dispose();
      } finally {
        // An already-released pass confirms itself; only pending or failed
        // releases keep the material quarantined until actual release.
        if (!pass.isReleased) shaderRetirement.add(pass);
      }
    }
    shaderParticles?.dispose();
    shaderProbe = null;
    shaderParticles = null;
  };
  let settleBuild!: (errors: readonly MaterialDiagnostic[]) => void;
  const ready = new Promise<readonly MaterialDiagnostic[]>((resolve) => { settleBuild = resolve; });
  materialBuilds.set(material, ready);
  const errorObserver = material.onBuildErrorObservable.add((message) => {
    buildError = message;
    const diagnostic: MaterialDiagnostic = { code: "material.compile.buildFailed", message, severity: "error" };
    if (buildState === "pending") {
      buildState = "failed";
      settleBuild([diagnostic]);
    } else {
      options.onTextureError?.(diagnostic);
    }
  });
  const buildObserver = material.onBuildObservable.add(() => {
    configureSurface();
    if (buildState === "pending") {
      if (checkingShader) return;
      if (plan.cost.customBlocks > 0 && scene.getEngine().getClassName() !== "NullEngine") {
        checkingShader = true;
        try {
        if (material.mode === NodeMaterialModes.Material) {
          shaderProbe = MeshBuilder.CreateBox(`${options.name}_compileProbe`, { size: 1 }, scene);
          shaderProbe.setEnabled(false);
          shaderProbe.material = material;
        } else if (plan.domain === "postProcess") {
          const pass = new OwnedPostProcess(`${options.name}PostProcess`, "postprocess", {
            camera: null,
            engine: scene.getEngine(),
            size: 1,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            blockCompilation: true,
            shaderLanguage: material.shaderLanguage,
          });
          // Assign before effect creation so a throw still retires the pass.
          shaderPostProcess = pass;
          material.createEffectForPostProcess(pass);
        } else {
          shaderParticles = new ParticleSystem(`${options.name}_compileProbe`, 1, scene);
          material.createEffectForParticles(shaderParticles);
        }
        } catch (error) {
          finishShaderCheck();
          buildState = "failed";
          settleBuild([materialGlslDiagnostic(String(error), plan.operations)]);
          return;
        }
        const started = Date.now();
        const check = () => {
          if (disposed) return;
          try {
            const subMesh = shaderProbe?.subMeshes[0];
            const effects = shaderParticles
              ? [shaderParticles.getCustomEffect(ParticleSystem.BLENDMODE_ONEONE), shaderParticles.getCustomEffect(ParticleSystem.BLENDMODE_MULTIPLY)]
              : [shaderPostProcess?.getEffect()];
            const ready = shaderProbe && subMesh ? material.isReadyForSubMesh(shaderProbe, subMesh) : effects.every((effect) => effect?.isReady());
            if (ready) {
              finishShaderCheck();
              buildState = "ready";
              settleBuild([]);
              return;
            }
            const effect = subMesh?.effect ?? effects.find((entry) => entry?.getCompilationError());
            const error = effect?.getCompilationError();
            if (error && effect?.allFallbacksProcessed()) throw new Error(error);
            if (Date.now() - started > 15000) throw new Error("Custom GLSL shader compilation timed out");
            shaderTimer = setTimeout(check, 16);
          } catch (error) {
            const diagnostic = materialGlslDiagnostic(error instanceof Error ? error.message : String(error), plan.operations, failedShaderEffect ?? shaderProbe?.subMeshes[0]?.effect ?? shaderPostProcess?.getEffect() ?? shaderParticles?.getCustomEffect());
            finishShaderCheck();
            buildState = "failed";
            settleBuild([diagnostic]);
          }
        };
        check();
        return;
      }
      buildState = "ready";
      if (cacheableShadowShape) registerCacheableShadowMaterial(material);
      if (!outlineMask && plan.domain === "surface" && plan.cost.customBlocks === 0) registerClusteredSurfaceMaterial(material);
      settleBuild([]);
    }
  });
  // Frozen NodeMaterials skip forced bindings when another mesh shared the effect.
  // Bone palettes and morph weights belong to each mesh, even when its material is static.
  const deformationBlocks = created.filter(
    (block): block is BonesBlock | MorphTargetsBlock =>
      block instanceof BonesBlock || block instanceof MorphTargetsBlock,
  );
  if (deformationBlocks.length > 0) {
    material.onBindObservable.add((mesh) => {
      if (!(mesh instanceof Mesh) || !material.isFrozen) return;
      const effect = material.getEffect();
      if (effect) {
        for (const block of deformationBlocks) block.bind(effect, material, mesh);
      }
    });
  }
  try {
    if (plan.operations.some((operation) => operation.nodeType === "input.environmentSample")) {
      const release = retainEnvironmentSample(scene, material);
      material.onDisposeObservable.addOnce(release);
    }
    material.build();
  } catch (error) {
    buildError =
      error instanceof Error ? error.message : "Material failed to build";
  }
  if (buildError !== null) {
    material.onBuildErrorObservable.remove(errorObserver);
    material.onBuildObservable.remove(buildObserver);
    diagnostics.push({
      code: "material.compile.buildFailed",
      message: buildError,
      severity: "error",
    });
    settleBuild(diagnostics);
    return fail();
  }

  configureSurface();

  const loadObservers: Array<() => void> = [];
  const rebuildWhenReady = (): void => {
    if (disposed) return;
    const wasFrozen = material.isFrozen;
    if (wasFrozen) material.unfreeze();
    try {
      material.build();
      configureSurface();
      markCompiledMaterialDirty(material);
    } catch (error) {
      // Must not throw into Texture.onLoadObservable / onErrorObservable.
      options.onTextureError?.({
        code: "material.compile.buildFailed",
        message:
          error instanceof Error ? error.message : "Material failed to rebuild",
        severity: "error",
      });
    } finally {
      if (wasFrozen && !material.isFrozen) material.freeze();
    }
  };
  for (const texture of pendingTextures) {
    if (isGpuTextureSampleReady(texture)) continue;
    if (texture.loadingError) {
      options.onTextureError?.({
        code: "material.missingTexture",
        message: "Texture failed to load",
        severity: "error",
      });
    }
    const observer = texture.onLoadObservable.addOnce(() => {
      rebuildWhenReady();
    });
    if (observer) {
      loadObservers.push(() => {
        texture.onLoadObservable.remove(observer);
      });
    }
    const errors = gpuTextureErrorObservable(texture);
    if (errors) {
      const errorObserver = errors.addOnce((payload) => {
        options.onTextureError?.({
          code: "material.missingTexture",
          message: textureErrorMessage(payload),
          severity: "error",
        });
      });
      if (errorObserver) {
        loadObservers.push(() => {
          errors.remove(errorObserver);
        });
      }
    }
  }

  const parameters = createMaterialParameterBindings(
    plan,
    realized,
    material,
    options.resolveTexture,
  );
  let variant: { compiled: CompiledMaterial; references: number } | undefined;
  const setParameter: CompiledMaterial["setParameter"] = (name, value) => {
    if (!parameters.setParameter(name, value)) return false;
    variant?.compiled.setParameter(name, value);
    return true;
  };
  const resetParameter: CompiledMaterial["resetParameter"] = (name) => {
    if (!parameters.resetParameter(name)) return false;
    const value = parameters.getParameter(name);
    if (value) variant?.compiled.setParameter(name, value);
    return true;
  };
  if (plan.domain === "surface" && !outlineMask) authoredOutlineFactories.set(material, () => {
    if (disposed) throw new Error("Cannot outline a disposed authored material.");
    if (!variant) {
      const compiled = compileMaterialPlan(plan, { ...options, name: `${options.name}:outlineMask`, surfaceVariant: "outlineMask" });
      if (materialCompileFailed(compiled)) throw new Error(compiled.diagnostics.map((entry) => entry.message).join("; "));
      for (const operation of plan.operations) if (operation.nodeType.startsWith("param.") && operation.source.callPath.length === 0) {
        const name = String(operation.properties.name ?? "").trim();
        const value = parameters.getParameter(name);
        if (value) compiled.setParameter(name, value);
      }
      variant = { compiled, references: 0 };
    }
    const retained = variant;
    retained.references++;
    let released = false;
    return { compiled: retained.compiled, release: async () => {
      if (released) return; released = true;
      if (--retained.references === 0) {
        if (variant === retained) variant = undefined;
        await retained.compiled.whenReleased();
      }
    } };
  });
  // The NodeMaterial stays quarantined until every owned compile-time pass
  // confirms actual native release; a release failure keeps it alive.
  let released: Promise<void> | null = null;
  const disposeCompiled = () => {
    if (disposed) return;
    disposed = true;
    authoredOutlineFactories.delete(material);
    finishShaderCheck();
    if (buildState === "pending") {
      buildState = "failed";
      settleBuild([{ code: "material.compile.cancelled", message: "Material build was cancelled", severity: "error" }]);
    }
    material.onBuildErrorObservable.remove(errorObserver);
    material.onBuildObservable.remove(buildObserver);
    parameters.dispose();
    for (const unsubscribe of loadObservers) unsubscribe();
    detachEngineOwnedTextures(material);
    if (shaderRetirement.releasedConfirmed) {
      material.dispose(false, false);
      released = Promise.resolve();
    } else {
      released = shaderRetirement.whenReleased().then(() => {
        if (!isDisposedNodeMaterial(material, scene)) material.dispose(false, false);
      });
      void released.catch((error: unknown) => {
        console.warn(`[render] Material "${options.name}" is quarantined until actual release: ${String(error)}`);
      });
    }
  };
  return {
    ok: true,
    material,
    ready,
    get buildState() { return buildState; },
    setParameter,
    getParameter: parameters.getParameter,
    resetParameter,
    dispose: disposeCompiled,
    whenReleased: () => {
      disposeCompiled();
      return released ?? Promise.resolve();
    },
  };
}

/** Drop ResourceCache textures so NodeMaterial.dispose cannot free engine-owned GPU wrappers. */
function detachEngineOwnedTextures(material: NodeMaterial): void {
  for (const block of material.attachedBlocks) {
    // A connected sample's getter forwards its ImageSourceBlock texture, while
    // its setter addresses separate, possibly uninitialized storage. Clear the
    // source owner instead so Babylon never scans materials with an undefined texture.
    if (block instanceof TextureBlock && block.hasImageSource) continue;
    const textured = block as { texture?: Texture | null };
    if (!textured.texture || !isEngineOwnedGpuTexture(textured.texture)) {
      continue;
    }
    textured.texture = null;
  }
}

type GpuTextureErrorObservable = {
  addOnce: (callback: (payload: unknown) => void) => unknown;
  remove: (observer: unknown) => void;
};

function gpuTextureErrorObservable(
  texture: Texture,
): GpuTextureErrorObservable | null {
  const host = texture as Texture & {
    onErrorObservable?: GpuTextureErrorObservable | null;
  };
  return host.onErrorObservable ?? null;
}

function textureErrorMessage(payload: unknown): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "Texture failed to load";
}

/** Map authored blend / two-sided onto Babylon after `material.build()`. */
function applyAuthoredSurfaceBlend(
  material: NodeMaterial,
  plan: MaterialBuildPlan,
): void {
  if (plan.domain === "postProcess" || plan.domain === "particle") {
    return;
  }
  material.backFaceCulling = plan.twoSided !== true;
  material.alphaMode = plan.blendMode === "additive" ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
  material.needDepthPrePass = false;
  switch (plan.blendMode) {
    case "masked":
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
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

/** Bind the shared sampler source for a parameter or an inline sample. */
function bindTexture(
  operation: MaterialOperation,
  plan: MaterialBuildPlan,
  realization: BlockRealization,
  options: CompileMaterialOptions,
  diagnostics: MaterialDiagnostic[],
  pendingTextures: Texture[],
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
  const block = (realization.outputs.textureOut?.ownerBlock ?? realization.blocks[0]) as unknown as {
    texture?: Texture | null;
  };
  block.texture = texture;
  if (!isGpuTextureSampleReady(texture)) pendingTextures.push(texture);
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
    // Babylon's floating-origin adapter recognizes u_World/u_View prefixes.
    // Keep the system matrix first; authored material names may be arbitrary.
    `${NodeMaterialSystemValues[systemValue]}_${name}`,
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
// ImageProcessingBlock normally expects display-space input and skips processing
// when no effects are enabled. Our PBR sum is linear, so it still needs the
// standard gamma conversion in that case, just like Babylon's PBR final output.
class LinearSurfaceImageProcessingBlock extends ImageProcessingBlock {
  override getClassName(): string {
    return "LinearSurfaceImageProcessingBlock";
  }

  override prepareDefines(
    defines: NodeMaterialDefines,
    material: NodeMaterial,
  ): void {
    super.prepareDefines(defines, material);
    if (!defines.IMAGEPROCESSINGPOSTPROCESS) defines.IMAGEPROCESSING = true;
  }
}

RegisterClass(
  "BABYLON.LinearSurfaceImageProcessingBlock",
  LinearSurfaceImageProcessingBlock,
);

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
  const fragment = new GeometrySurfaceOutputBlock(`${options.name}_fragment`);
  connectGeometrySurfaceOutput(fragment, plumbing, outputPoint("normal", `${options.name}_geometryNormal`, false), created);
  created.push(fragment);

  const baseColor = outputPoint("baseColor", `${options.name}_baseColor`, true);
  const emissionOperand = plan.outputs.emissive;
  const hasEmission =
    emissionOperand &&
    !(
      emissionOperand.kind === "constant" &&
      emissionOperand.value.every((value) => value === 0)
    );
  const emissive = hasEmission
    ? outputPoint("emissive", `${options.name}_emissive`, true)
    : null;
  const addColor = (
    left: NodeMaterialConnectionPoint,
    right: NodeMaterialConnectionPoint,
    suffix: string,
  ) => {
    const add = new AddBlock(`${options.name}_${suffix}`);
    created.push(add);
    left.connectTo(add.left);
    right.connectTo(add.right);
    return add.output;
  };

  if (plan.shadingModel === "unlit") {
    fragment.convertToGammaSpace = true;
    const color =
      baseColor && emissive
        ? addColor(baseColor, emissive, "unlitEmission")
        : (baseColor ?? emissive);
    if (color) color.connectTo(fragment.rgb);
    const opacity = outputPoint("opacity", `${options.name}_opacity`, false);
    if (opacity) opacity.connectTo(fragment.a);
    return fragment;
  }

  const pbr = new ScenePbrLightingBlock(`${options.name}_pbr`);
  pbr.useAlphaBlending = plan.blendMode === "translucent" || plan.blendMode === "additive";
  pbr.alpha.connectTo(fragment.a);
  const reflection = new SceneReflectionBlock(`${options.name}_reflection`);
  plumbing.position?.connectTo(reflection.position);
  plumbing.world?.connectTo(reflection.world);
  reflection.reflection.connectTo(pbr.reflection);
  created.push(reflection);
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
  const roughness = outputPoint(
    "roughness",
    `${options.name}_roughness`,
    false,
  );
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

  const environmentOperand = plan.outputs.environmentInfluence;
  const customEnvironment = environmentOperand && !(environmentOperand.kind === "constant" && environmentOperand.value[0] === 1);
  if (emissive || customEnvironment) {
    // These are the linear contributions supported by our surface compiler.
    // pbr.lighting has already passed through image processing and must not be
    // used for an additive linear emissive contribution.
    const diffuse = addColor(pbr.ambientClr, pbr.diffuseDir, "diffuseColor");
    const lit = addColor(diffuse, pbr.specularDir, "litColor");
    let indirect = addColor(pbr.diffuseInd, pbr.specularInd, "environmentColor");
    if (customEnvironment) {
      const influence = outputPoint("environmentInfluence", `${options.name}_environmentInfluence`, false)!;
      const clamp = new ClampBlock(`${options.name}_environmentInfluenceClamp`);
      clamp.minimum = 0;
      clamp.maximum = 1;
      const scale = new ScaleBlock(`${options.name}_environmentInfluenceScale`);
      created.push(clamp, scale);
      influence.connectTo(clamp.value);
      clamp.output.connectTo(scale.factor);
      indirect.connectTo(scale.input);
      indirect = scale.output;
    }
    const lighting = addColor(lit, indirect, "totalLighting");
    const color = emissive ? addColor(lighting, emissive, "surfaceEmission") : lighting;
    const imageProcessing = new LinearSurfaceImageProcessingBlock(
      `${options.name}_imageProcessing`,
    );
    imageProcessing.convertInputToLinearSpace = false;
    created.push(imageProcessing);
    color.connectTo(imageProcessing.color);
    imageProcessing.rgb.connectTo(fragment.rgb);
  } else {
    pbr.lighting.connectTo(fragment.rgb);
  }
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
  const errors = await materialBuilds.get(material);
  if (errors?.length) throw new Error(errors[0]!.message);
  if (!mesh) return;
  if (material.mode === NodeMaterialModes.Particle) return;
  if (!nodeMaterialTexturesSampleReady(material)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      material.forceCompilationAsync(mesh),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Material shader compilation timed out")), 4000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Babylon internals contract: every private member, prototype method and patched behaviour of the pinned
 * `@babylonjs/core` that `packages/render/src` reads, writes, wraps or re-implements, checked on the real classes.
 * A Babylon upgrade that renames, removes or reshapes one fails here, naming the Haptic file that depends on it,
 * before it fails at runtime through a cast `tsc` cannot see. Upgrade procedure: render.md, "Babylon pin and
 * workarounds".
 *
 * The inventory is grouped by the Haptic file that depends on each member. Kinds:
 * - `method`: a function on the owner's prototype chain (`arity` where the Haptic code forwards or checks it);
 * - `static`: a member of the owner class itself;
 * - `accessor`: a getter (and setter where Haptic writes it) on the owner's prototype chain;
 * - `field`: an own or inherited property of a freshly constructed owner, of the given value type;
 * - `referenced`: a property absent from a fresh object (assigned lazily, or by a module that augments the class): the
 *   source of the class, its ancestors or its listed extension modules names it;
 * - `patched`: a method whose source carries a hunk of `patches/@babylonjs__core@9.29.0.patch` Haptic relies on.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animation } from "@babylonjs/core/Animations/animation";
import { RuntimeAnimation } from "@babylonjs/core/Animations/runtimeAnimation";
import { _WebAudioBus } from "@babylonjs/core/AudioV2/webAudio/webAudioBus";
import { _WebAudioEngine } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import { _WebAudioMainBus } from "@babylonjs/core/AudioV2/webAudio/webAudioMainBus";
import { _WebAudioMainOut } from "@babylonjs/core/AudioV2/webAudio/webAudioMainOut";
import { _WebAudioStaticSound } from "@babylonjs/core/AudioV2/webAudio/webAudioStaticSound";
import { _WebAudioStreamingSound } from "@babylonjs/core/AudioV2/webAudio/webAudioStreamingSound";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { WebGLHardwareTexture } from "@babylonjs/core/Engines/WebGL/webGLHardwareTexture";
import { WebGLRenderTargetWrapper } from "@babylonjs/core/Engines/WebGL/webGLRenderTargetWrapper";
import { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphPass } from "@babylonjs/core/FrameGraph/Passes/pass";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { AxisDragGizmo } from "@babylonjs/core/Gizmos/axisDragGizmo";
import { AxisScaleGizmo } from "@babylonjs/core/Gizmos/axisScaleGizmo";
import { Gizmo } from "@babylonjs/core/Gizmos/gizmo";
import { PlaneDragGizmo } from "@babylonjs/core/Gizmos/planeDragGizmo";
import { PlaneRotationGizmo } from "@babylonjs/core/Gizmos/planeRotationGizmo";
import { PositionGizmo } from "@babylonjs/core/Gizmos/positionGizmo";
import { RotationGizmo } from "@babylonjs/core/Gizmos/rotationGizmo";
import { ScaleGizmo } from "@babylonjs/core/Gizmos/scaleGizmo";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Light } from "@babylonjs/core/Lights/light";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { CurrentScreenBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/currentScreenBlock";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { DrawWrapper } from "@babylonjs/core/Materials/drawWrapper";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Material } from "@babylonjs/core/Materials/material";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { MaterialPluginManager } from "@babylonjs/core/Materials/materialPluginManager";
import { PushMaterial } from "@babylonjs/core/Materials/pushMaterial";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ParticleInputBlock } from "@babylonjs/core/Particles/Node/Blocks/particleInputBlock";
import { NodeParticleBlockConnectionPointTypes } from "@babylonjs/core/Particles/Node/Enums/nodeParticleBlockConnectionPointTypes";
import { NodeParticleBlock } from "@babylonjs/core/Particles/Node/nodeParticleBlock";
import { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import { GPUParticleSystem } from "@babylonjs/core/Particles/gpuParticleSystem";
import { Particle } from "@babylonjs/core/Particles/particle";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { ThinParticleSystem } from "@babylonjs/core/Particles/thinParticleSystem";
import { WebGL2ParticleSystem } from "@babylonjs/core/Particles/webgl2ParticleSystem";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { ThinBloomEffect } from "@babylonjs/core/PostProcesses/thinBloomEffect";
import { BoundingBoxRenderer } from "@babylonjs/core/Rendering/boundingBoxRenderer";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";

type ValueType = "number" | "boolean" | "string" | "function" | "object" | "array" | "map" | "null";
type Row =
  | { kind: "method"; owner: OwnerName; member: string; arity?: number }
  | { kind: "static"; owner: OwnerName; member: string; type: ValueType; arity?: number }
  | { kind: "accessor"; owner: OwnerName; member: string; setter: boolean }
  | { kind: "field"; owner: OwnerName; member: string; type?: ValueType }
  | { kind: "referenced"; owner: OwnerName; member: string }
  | { kind: "patched"; owner: OwnerName; member: string; has: string[]; lacks?: string[]; why: string };

const method = (owner: OwnerName, member: string, arity?: number): Row => ({ kind: "method", owner, member, arity });
const statics = (owner: OwnerName, member: string, type: ValueType, arity?: number): Row => ({ kind: "static", owner, member, type, arity });
const accessor = (owner: OwnerName, member: string, setter = false): Row => ({ kind: "accessor", owner, member, setter });
const field = (owner: OwnerName, member: string, type?: ValueType): Row => ({ kind: "field", owner, member, type });
const referenced = (owner: OwnerName, member: string): Row => ({ kind: "referenced", owner, member });
const patched = (owner: OwnerName, member: string, why: string, has: string[], lacks?: string[]): Row =>
  ({ kind: "patched", owner, member, has, lacks, why });
const methods = (owner: OwnerName, ...members: string[]) => members.map((member) => method(owner, member));
const referencedAll = (owner: OwnerName, ...members: string[]) => members.map((member) => referenced(owner, member));

/** The Babylon classes the inventory names, with a fresh instance where `field` rows need one. */
type Context = { engine: NullEngine; scene: Scene; box: Mesh; frameGraph: FrameGraph; particles: ParticleSystem; light: DirectionalLight };
type OwnerSpec = { cls: abstract new (...args: never[]) => object; make?: (context: Context) => object };
const OWNERS = {
  AbstractMesh: { cls: AbstractMesh, make: ({ box }) => box },
  /** `AbstractMesh._internalAbstractMeshDataInfo`, whose class Babylon does not export. */
  AbstractMeshDataInfo: { cls: Object, make: ({ box }) => (box as unknown as { _internalAbstractMeshDataInfo: object })._internalAbstractMeshDataInfo },
  Animation: { cls: Animation },
  AxisDragGizmo: { cls: AxisDragGizmo },
  AxisScaleGizmo: { cls: AxisScaleGizmo },
  BaseTexture: { cls: BaseTexture, make: ({ scene }) => new BaseTexture(scene) },
  BoundingBoxRenderer: { cls: BoundingBoxRenderer },
  Camera: { cls: Camera, make: ({ scene }) => new TargetCamera("contract camera", Vector3.Zero(), scene) },
  CascadedShadowGenerator: { cls: CascadedShadowGenerator },
  CurrentScreenBlock: { cls: CurrentScreenBlock, make: () => new CurrentScreenBlock("contract screen") },
  DrawWrapper: { cls: DrawWrapper, make: ({ engine }) => new DrawWrapper(engine) },
  Effect: { cls: Effect },
  Engine: { cls: Engine, make: ({ engine }) => engine },
  FrameGraph: { cls: FrameGraph, make: ({ frameGraph }) => frameGraph },
  FrameGraphBloomTask: { cls: FrameGraphBloomTask },
  FrameGraphCullObjectsTask: { cls: FrameGraphCullObjectsTask },
  FrameGraphGeometryRendererTask: {
    cls: FrameGraphGeometryRendererTask, make: ({ frameGraph, scene }) => new FrameGraphGeometryRendererTask("contract geometry", frameGraph, scene),
  },
  FrameGraphObjectRendererTask: {
    cls: FrameGraphObjectRendererTask, make: ({ frameGraph, scene }) => new FrameGraphObjectRendererTask("contract objects", frameGraph, scene),
  },
  FrameGraphPass: { cls: FrameGraphPass },
  FrameGraphPostProcessTask: { cls: FrameGraphPostProcessTask },
  FrameGraphRenderContext: { cls: FrameGraphRenderContext },
  FrameGraphTask: { cls: FrameGraphTask, make: ({ frameGraph, scene }) => new FrameGraphObjectRendererTask("contract task", frameGraph, scene) },
  Geometry: { cls: Geometry, make: ({ box }) => box.geometry! },
  Gizmo: { cls: Gizmo },
  GPUParticleSystem: {
    cls: GPUParticleSystem,
    make: ({ engine, scene }) => {
      // A shipped WebGL2 Engine has transform feedback; NullEngine reports none.
      vi.spyOn(engine, "getCaps").mockReturnValue({ ...engine.getCaps(), supportTransformFeedbacks: true });
      return new GPUParticleSystem("contract gpu", { capacity: 4, emitRateControl: true }, scene);
    },
  },
  ImageProcessingConfiguration: { cls: ImageProcessingConfiguration },
  InstancedMesh: { cls: InstancedMesh, make: ({ box }) => box.createInstance("contract instance") },
  InternalTexture: { cls: InternalTexture, make: ({ engine }) => new InternalTexture(engine, InternalTextureSource.Unknown) },
  Light: { cls: Light, make: ({ light }) => light },
  Material: { cls: Material, make: ({ scene }) => new StandardMaterial("contract standard", scene) },
  MaterialDefines: { cls: MaterialDefines, make: () => new MaterialDefines() },
  MaterialPluginBase: { cls: MaterialPluginBase },
  MaterialPluginManager: { cls: MaterialPluginManager },
  PushMaterial: { cls: PushMaterial },
  Mesh: { cls: Mesh, make: ({ box }) => box },
  Node: { cls: Node, make: ({ box }) => box },
  NodeMaterial: { cls: NodeMaterial, make: ({ scene }) => new NodeMaterial("contract node", scene) },
  NodeMaterialBlock: { cls: NodeMaterialBlock, make: () => new NodeMaterialBlock("contract block") },
  NodeMaterialBuildState: { cls: NodeMaterialBuildState, make: () => new NodeMaterialBuildState() },
  NodeMaterialConnectionPoint: {
    cls: NodeMaterialConnectionPoint, make: () => new NodeMaterialConnectionPoint("point", new NodeMaterialBlock("contract owner")),
  },
  NodeParticleBlock: { cls: NodeParticleBlock, make: () => new NodeParticleBlock("contract particle block") },
  NodeParticleConnectionPoint: {
    cls: NodeParticleConnectionPoint,
    make: () => new NodeParticleConnectionPoint("point", new NodeParticleBlock("contract owner"), NodeParticleBlockConnectionPointTypes.Float),
  },
  ObjectRenderer: { cls: ObjectRenderer, make: ({ scene }) => new ObjectRenderer("contract renderer", scene) },
  Particle: { cls: Particle, make: ({ particles }) => new Particle(particles) },
  ParticleInputBlock: { cls: ParticleInputBlock, make: () => new ParticleInputBlock("contract input") },
  PBRBaseMaterial: { cls: PBRBaseMaterial, make: ({ scene }) => new PBRMaterial("contract pbr", scene) },
  PlaneDragGizmo: { cls: PlaneDragGizmo },
  PlaneRotationGizmo: { cls: PlaneRotationGizmo },
  PositionGizmo: { cls: PositionGizmo },
  PostProcess: { cls: PostProcess },
  RenderingGroup: { cls: RenderingGroup, make: ({ scene }) => new RenderingGroup(0, scene) },
  RenderingManager: { cls: RenderingManager, make: ({ scene }) => new RenderingManager(scene) },
  RenderTargetTexture: { cls: RenderTargetTexture, make: ({ scene }) => new RenderTargetTexture("contract target", 4, scene) },
  RenderTargetWrapper: { cls: RenderTargetWrapper },
  RotationGizmo: { cls: RotationGizmo },
  RuntimeAnimation: { cls: RuntimeAnimation },
  ScaleGizmo: { cls: ScaleGizmo },
  Scene: { cls: Scene, make: ({ scene }) => scene },
  ShadowDepthWrapper: { cls: ShadowDepthWrapper, make: ({ scene }) => new ShadowDepthWrapper(new NodeMaterial("contract caster", scene), scene) },
  ShadowGenerator: { cls: ShadowGenerator, make: ({ light }) => new ShadowGenerator(64, light) },
  StandardMaterial: { cls: StandardMaterial, make: ({ scene }) => new StandardMaterial("contract standard", scene) },
  SubMesh: { cls: SubMesh, make: ({ box }) => box.subMeshes[0]! },
  ThinBloomEffect: { cls: ThinBloomEffect },
  ThinParticleSystem: { cls: ThinParticleSystem, make: ({ particles }) => particles },
  TransformNode: { cls: TransformNode, make: ({ scene }) => new TransformNode("contract node", scene) },
  WebAudioBus: { cls: _WebAudioBus },
  WebAudioEngine: { cls: _WebAudioEngine },
  WebAudioMainBus: { cls: _WebAudioMainBus },
  WebAudioMainOut: { cls: _WebAudioMainOut },
  WebAudioStaticSound: { cls: _WebAudioStaticSound },
  WebAudioStreamingSound: { cls: _WebAudioStreamingSound },
  WebGL2ParticleSystem: { cls: WebGL2ParticleSystem },
  WebGLHardwareTexture: { cls: WebGLHardwareTexture },
  WebGLRenderTargetWrapper: { cls: WebGLRenderTargetWrapper },
} satisfies Record<string, OwnerSpec>;
type OwnerName = keyof typeof OWNERS;

/** Babylon modules that install a member on a prototype from outside its class (engine extensions). */
const EXTENSION_SOURCES: Partial<Record<OwnerName, string[]>> = {
  Engine: ["Engines/Extensions/engine.query.pure.js"],
  Mesh: ["Meshes/instancedMesh.pure.js", "Meshes/thinInstanceMesh.pure.js"],
  Scene: ["Lights/areaLight.pure.js", "Rendering/depthPeelingSceneComponent.pure.js"],
};

/** The NodeMaterialBuildState API every authored node block emits through (`*-block.ts`, `material-*.ts`, …). */
const BUILD_STATE = [
  ...methods("NodeMaterialBuildState", "_getFreeVariableName", "_getFreeDefineName", "_emitUniformFromString", "_emitVaryingFromString",
    "_declareOutput", "_declareLocalVar", "_emitFunction", "_emitFunctionFromInclude", "_emitCodeFromInclude", "_emitExtension",
    "_emit2DSampler", "_emit2DArraySampler", "_emitCubeSampler", "_getShaderType", "_generateTextureSample", "_generateTextureSampleLOD"),
  field("NodeMaterialBuildState", "_attributeDeclaration"),
  field("NodeMaterialBuildState", "_samplerDeclaration"),
  field("NodeMaterialBuildState", "_injectAtEnd"),
  referenced("NodeMaterial", "_vertexState"),
  field("NodeMaterialBlock", "_inputs", "array"),
  field("NodeMaterialBlock", "_outputs", "array"),
  method("NodeMaterialBlock", "_buildBlock", 1),
  method("NodeMaterialBlock", "_deserialize", 4),
];

/** The NodeParticleBlock API the particle blocks build through. */
const PARTICLE_BLOCK = [
  field("NodeParticleBlock", "_inputs", "array"),
  field("NodeParticleBlock", "_outputs", "array"),
  method("NodeParticleBlock", "_build", 1),
  field("NodeParticleConnectionPoint", "_storedValue"),
  field("NodeParticleConnectionPoint", "_storedFunction"),
];

/** Each Haptic file in `packages/render/src` and the Babylon 9.29 internals it depends on. */
const INVENTORY: Record<string, Row[]> = {
  "node material blocks (every NodeMaterialBlock subclass)": BUILD_STATE,
  "particle graph blocks (every NodeParticleBlock subclass)": PARTICLE_BLOCK,
  "allocation-checkpoint.ts": [field("Engine", "_renderTargetWrapperCache", "array")],
  "alpha-to-coverage.ts": [method("Material", "_afterBind")],
  "anim-foot-placement.ts": [field("Mesh", "_thinInstanceDataStorage", "object")],
  // Re-implements the track interpolation.
  "anim-pose.ts": [method("Animation", "_interpolate")],
  "area-light-resources.ts": [referenced("Scene", "_ltcTextures")],
  "authored-shadow-depth-wrapper.ts": [
    method("SubMesh", "_getDrawWrapper"), method("SubMesh", "_removeDrawWrapper"), method("Geometry", "_releaseVertexArrayObject"),
    field("ShadowDepthWrapper", "_subMeshToDepthWrapper", "object"), field("ShadowDepthWrapper", "_subMeshToEffect", "map"),
    patched("ShadowDepthWrapper", "_makeEffect", "depth Effects keyed by source and defines, not a token per entry", ["createEffect"],
      ["vertexToken", "fragmentToken"]),
  ],
  "babylon-audio-backend.ts": [
    accessor("WebAudioStaticSound", "_outNode"), accessor("WebAudioStreamingSound", "_outNode"), accessor("WebAudioBus", "_outNode"),
    accessor("WebAudioMainOut", "_inNode"), accessor("WebAudioMainBus", "_inNode"), referenced("WebAudioEngine", "_audioContext"),
  ],
  "backbuffer-invalidate.ts": [referenced("Engine", "_gl"), field("Engine", "_currentFramebuffer", "null")],
  // Mirrors the cascade split and its view-space ends.
  "cascade-split.ts": [method("CascadedShadowGenerator", "_splitFrustum"), referenced("CascadedShadowGenerator", "_viewSpaceFrustumsZ")],
  "context-lost-error.ts": [field("Engine", "_contextWasLost", "boolean")],
  "create-engine.ts": [
    field("Engine", "_contextWasLost", "boolean"), field("Engine", "_frameHandler", "number"), field("Engine", "_virtualScenes", "array"),
    field("Engine", "_windowIsBackground", "boolean"), method("Engine", "_renderViews"),
  ],
  "decal-pass.ts": [method("FrameGraphRenderContext", "_applyRenderTarget"), accessor("SubMesh", "_drawWrapper"), field("FrameGraphTask", "_frameGraph", "object")],
  "direct-view-presentation.ts": [referenced("Engine", "_gl"), field("Engine", "_currentFramebuffer", "null")],
  "draw-batching.ts": [statics("RenderingGroup", "_RenderSorted", "function", 5), field("Scene", "_activeMeshesFrozenButKeepClipping", "boolean")],
  "draw-calls.ts": [field("Engine", "_drawCalls", "object")],
  // Repeats `_checkReadiness`'s mesh filter and default list.
  "driver-compile.ts": [method("ObjectRenderer", "_checkReadiness"), field("Engine", "_compiledEffects", "object")],
  "dynamic-runtime-mesh.ts": [method("Geometry", "_resetPointsArrayCache")],
  "editor-debug-overlay.ts": [field("Scene", "_blockEntityCollection", "boolean"), field("Engine", "_currentRenderTarget", "null")],
  "effect-bridge.ts": [field("Engine", "_compiledEffects", "object"), referenced("Effect", "_refCount")],
  "effect-requests.ts": [field("Engine", "_compiledEffects", "object")],
  "engine-drawing-state.ts": [
    method("Engine", "_bindUnboundFramebuffer"), field("Engine", "_currentFramebuffer", "null"), field("Engine", "_currentRenderTarget", "null"),
  ],
  "engine-gpu-timing.ts": [referenced("Engine", "_captureGPUFrameTime")],
  "environment-base-radiance.ts": [referenced("Engine", "_gl"), method("Engine", "_readPixelsAsync"), method("Engine", "_readTexturePixels")],
  "environment-irradiance.ts": [referenced("InternalTexture", "_hardwareTexture"), referenced("InternalTexture", "_sphericalPolynomial")],
  "environment-lighting.ts": [
    field("SubMesh", "_drawWrappers", "array"), field("DrawWrapper", "_forceRebindOnNextCall", "boolean"), field("Material", "_materialContext"),
    field("BaseTexture", "_texture", "null"), referenced("BaseTexture", "_prefiltered"),
  ],
  "environment-prefilter.ts": [field("Engine", "_features", "object"), field("BaseTexture", "_texture", "null"), referenced("BaseTexture", "_prefiltered")],
  "fbx-conversion.ts": [referenced("InternalTexture", "_buffer")],
  "first-draw-stats.ts": [field("Engine", "_compiledEffects", "object"), referenced("Engine", "_currentEffect")],
  "foliage-fade.ts": [
    field("SubMesh", "_drawWrappers", "array"), method("MaterialPluginBase", "_enable"), referenced("PushMaterial", "_renderId"),
    field("DrawWrapper", "_wasPreviouslyReady", "boolean"), field("DrawWrapper", "_wasPreviouslyUsingInstances", "null"),
  ],
  "framegraph-borrowed-draw.ts": [
    field("Engine", "_currentRenderTarget", "null"), field("RenderTargetTexture", "_disableEngineStages", "boolean"),
    field("Scene", "_intermediateRendering", "boolean"),
  ],
  "framegraph-forward-scene.ts": [
    referenced("Scene", "_activeCamera"), field("Scene", "_activeMeshesFrozen", "boolean"), field("Engine", "_compiledEffects", "object"),
    field("Engine", "_currentRenderTarget", "null"), method("FrameGraphCullObjectsTask", "_execute", 0), method("SubMesh", "_getDrawWrapper"),
    field("Scene", "_intermediateRendering", "boolean"), field("FrameGraph", "_renderContext", "object"), method("FrameGraphRenderContext", "_isReady"),
    field("Scene", "_isReadyChecks", "array"), field("Camera", "_postProcesses", "array"), referenced("Scene", "_depthPeelingRenderer"),
  ],
  "framegraph-logical-buffers.ts": [
    method("FrameGraphObjectRendererTask", "_checkTextureCompatibility", 1), field("FrameGraphGeometryRendererTask", "_clearAttachmentsLayout", "map"),
    field("FrameGraphGeometryRendererTask", "_colorAttachmentsLayout", "array"), field("Engine", "_currentRenderTarget", "null"),
    field("FrameGraphTask", "_frameGraph", "object"), referenced("Engine", "_gl"), method("FrameGraphGeometryRendererTask", "_prepareRendering", 2),
    referenced("FrameGraphObjectRendererTask", "_textureWidth"), referenced("FrameGraphObjectRendererTask", "_textureHeight"),
  ],
  "framegraph-managed-shadows.ts": [
    field("FrameGraphTask", "_frameGraph", "object"), method("FrameGraphObjectRendererTask", "_getTargetHandles"),
    field("Scene", "_intermediateRendering", "boolean"), field("FrameGraphObjectRendererTask", "_onAfterRenderObservable", "null"),
    field("FrameGraphObjectRendererTask", "_onBeforeRenderObservable", "null"), method("FrameGraphObjectRendererTask", "_prepareRendering", 2),
    field("FrameGraphObjectRendererTask", "_renderer", "object"), field("FrameGraphObjectRendererTask", "_scene", "object"),
    method("FrameGraphObjectRendererTask", "_setLightsForShadow", 0), method("RenderTargetTexture", "_shouldRender"),
  ],
  "framegraph-post-process.ts": [field("FrameGraphTask", "_frameGraph", "object")],
  "framegraph-test-fixtures.ts": [method("Engine", "_createHardwareRenderTargetWrapper"), method("Engine", "_createInternalTexture")],
  "fsr1-tasks.ts": referencedAll("FrameGraphPostProcessTask", "_postProcessDrawWrapper", "_sourceWidth", "_sourceHeight", "_outputWidth", "_outputHeight"),
  "full-target-clear.ts": [
    method("FrameGraphRenderContext", "_applyRenderTarget"), referenced("FrameGraphPass", "_executeFunc"), referenced("Effect", "_fragmentSourceCode"),
    ...referencedAll("ThinBloomEffect", "_downscale", "_blurX", "_blurY", "_merge"),
  ],
  "geometry-repeat-probe.ts": [field("FrameGraphTask", "_frameGraph", "object"), method("FrameGraphGeometryRendererTask", "_prepareRendering", 2)],
  "geometry-surface-output-block.ts": [field("NodeMaterialConnectionPoint", "_enforceAssociatedVariableName", "boolean")],
  "gizmo-host.ts": [
    ...[ "AxisDragGizmo", "PlaneDragGizmo", "PlaneRotationGizmo", "AxisScaleGizmo"].flatMap((owner) =>
      referencedAll(owner as OwnerName, "_coloredMaterial", "_hoverMaterial", "_disableMaterial")),
    referenced("PositionGizmo", "_gizmoAxisCache"), referenced("RotationGizmo", "_gizmoAxisCache"), referenced("ScaleGizmo", "_gizmoAxisCache"),
    referenced("Gizmo", "_rootMesh"), field("Engine", "_currentRenderTarget", "null"), referenced("Camera", "_scene"),
  ],
  "gpu-busy-probe.ts": [referenced("Engine", "_gl")],
  "gpu-object-id-picker.ts": [field("AbstractMesh", "_masterMesh", "null"), method("Engine", "_readTexturePixels")],
  "gpu-pick-candidates.ts": [method("Mesh", "_getRenderingFillMode"), field("AbstractMesh", "_masterMesh", "null")],
  "gpu-probe-engine.ts": [referenced("Engine", "_captureGPUFrameTime"), referenced("Engine", "_gl")],
  "haptic-lighting-block.ts": [
    referenced("Engine", "_gl"), referenced("BaseTexture", "_texture"),
    patched("Engine", "_bindSamplerObject", "texture units bind the sampler object `_samplerObjectFor` names", ["_samplerObjectFor"]),
    patched("Engine", "_bindTexture", "every texture bind asks for its sampler object", ["_bindSamplerObject"]),
  ],
  "haptic-lights.ts": [method("Engine", "_releaseBuffer")],
  "instance-pool.ts": [
    field("SubMesh", "_drawWrappers", "array"), field("Node", "_internalMetadata"), field("InstancedMesh", "_sourceMesh", "object"),
    method("InstancedMesh", "_syncSubMeshes"),
  ],
  "instance-uploads.ts": [
    patched("Mesh", "_updateInstancedBuffers", "a batch's rows fill and upload only when `Scene._instanceUploads` does not keep them",
      ["_instanceUploads", ".kept(", ".uploaded("]),
    patched("Mesh", "_processInstancedBuffers", "user instance attributes upload only when `_instanceUploads` does not keep them",
      ["_instanceUploads", "attributesKept"]),
  ],
  "landscape-mesh.ts": [field("SubMesh", "_id", "number")],
  "lattice-deformer-binding.ts": [field("AbstractMesh", "_masterMesh", "null")],
  "lattice-deformer-block.ts": [method("NodeMaterialBlock", "_deserialize", 4)],
  "lattice-deformer-native.ts": [method("MaterialPluginBase", "_enable"), referenced("MaterialPluginBase", "_material")],
  "lattice-deformer.ts": [field("AbstractMesh", "_masterMesh", "null")],
  "layer-draw-list.ts": [
    field("ObjectRenderer", "_activeBoundingBoxes", "object"), field("ObjectRenderer", "_activeMeshes", "object"),
    field("ObjectRenderer", "_prepareRenderingManager", "function"), field("ObjectRenderer", "_renderingManager", "object"),
    field("Scene", "_activeMeshesFrozen", "boolean"), field("Scene", "_activeMeshesFrozenButKeepClipping", "boolean"),
    field("SubMesh", "_alphaIndex", "number"), field("SubMesh", "_distanceToCamera", "number"),
    field("RenderingGroup", "_opaqueSubMeshes", "object"), field("RenderingGroup", "_alphaTestSubMeshes", "object"),
    field("RenderingGroup", "_transparentSubMeshes", "object"), field("RenderingGroup", "_depthOnlySubMeshes", "object"),
    field("RenderingGroup", "_opaqueSortCompareFn"), field("RenderingGroup", "_alphaTestSortCompareFn"), field("RenderingGroup", "_transparentSortCompareFn"),
    field("RenderingGroup", "_empty", "boolean"), field("RenderingManager", "_renderingGroups", "array"),
    referenced("AbstractMesh", "_edgesRenderer"), method("Camera", "_updateFrustumPlanes", 0), referenced("Camera", "_frustumPlanes"),
  ],
  "layer-frame-stats.ts": [method("Engine", "_bindUnboundFramebuffer"), field("Engine", "_currentFramebuffer", "null")],
  "layer-image-atlas.ts": [field("InternalTexture", "_compression", "null"), field("InternalTexture", "_useSRGBBuffer", "boolean"), field("InternalTexture", "_isRGBD", "boolean")],
  "lean-render-preparation.ts": [
    field("AbstractMesh", "_internalAbstractMeshDataInfo", "object"), field("AbstractMeshDataInfo", "_currentLOD", "map"),
    field("AbstractMeshDataInfo", "_wasActiveLastFrame", "boolean"), field("AbstractMeshDataInfo", "_isActiveIntermediate", "boolean"),
    field("AbstractMeshDataInfo", "_onlyForInstancesIntermediate", "boolean"), field("AbstractMeshDataInfo", "_actAsRegularMesh", "boolean"),
    method("AbstractMesh", "_preActivateForIntermediateRendering", 1), method("AbstractMesh", "_activate", 2), method("AbstractMesh", "_postActivate", 0),
    field("AbstractMesh", "_renderingGroup", "null"), field("AbstractMesh", "_renderId", "number"), referenced("AbstractMesh", "_edgesRenderer"),
    field("Node", "_nodeDataStorage", "object"), field("Mesh", "_internalMeshDataInfo", "object"), referenced("InstancedMesh", "_currentLOD"),
    referenced("SubMesh", "_renderingMesh"), referenced("SubMesh", "_wasDispatched"),
    field("RenderingGroup", "_opaqueSubMeshes", "object"), field("RenderingGroup", "_alphaTestSubMeshes", "object"),
    field("RenderingGroup", "_transparentSubMeshes", "object"), field("RenderingGroup", "_depthOnlySubMeshes", "object"),
    field("RenderingGroup", "_edgesRenderers", "object"), field("RenderingGroup", "_empty", "boolean"),
    field("RenderingManager", "_renderingGroups", "array"), field("RenderingManager", "_disableDepthPrePass", "boolean"),
    field("ObjectRenderer", "_prepareRenderingManager", "function"), field("ObjectRenderer", "_renderingManager", "object"),
    field("ObjectRenderer", "_activeMeshes", "object"), field("ObjectRenderer", "_activeBoundingBoxes", "object"),
    referenced("ObjectRenderer", "_defaultRenderListPrepared"), field("ObjectRenderer", "_isFrozen", "boolean"),
    field("ObjectRenderer", "_renderPassIds", "array"), field("ObjectRenderer", "_scene", "object"),
    field("Scene", "_activeMeshesFrozen", "boolean"), method("Scene", "_prepareSkeleton", 1),
    method("BoundingBoxRenderer", "_preActiveMesh", 1), method("BoundingBoxRenderer", "_evaluateSubMesh", 2),
    method("Mesh", "_registerInstanceForRenderId", 2),
    patched("Mesh", "_registerInstanceForRenderId", "a source's visible-instance record starts anew with each Engine frame",
      ["visibleInstancesFrameId"]),
  ],
  "light-free-meshes.ts": [
    referenced("Scene", "_defaultMaterial"), field("AbstractMesh", "_internalAbstractMeshDataInfo", "object"),
    referenced("AbstractMesh", "_materialForRenderPass"),
    patched("AbstractMesh", "_markSubMeshesAsLightDirty", "a mesh `Scene._lightFreeMesh` names is not marked light-dirty", ["_lightFreeMesh"]),
  ],
  "light-neutral-tasks.ts": [method("FrameGraphObjectRendererTask", "_setLightsForShadow", 0)],
  "logical-scene-texture-block.ts": [field("CurrentScreenBlock", "_samplerName", "string")],
  "material-compiler.ts": [
    statics("NodeMaterial", "_BuildIdGenerator", "number"), field("NodeMaterial", "_buildIsInProgress", "boolean"),
    field("NodeMaterial", "_buildWasSuccessful", "boolean"),
  ],
  "mesh-environment.ts": [
    method("PBRBaseMaterial", "isReadyForSubMesh"), method("PBRBaseMaterial", "bindForSubMesh", 3),
    method("NodeMaterial", "isReadyForSubMesh"), method("NodeMaterial", "bindForSubMesh", 3),
    field("Scene", "_environmentTexture", "null"), accessor("SubMesh", "_drawWrapper"), field("DrawWrapper", "_forceRebindOnNextCall", "boolean"),
  ],
  "mirrors.ts": [field("Engine", "_alphaState", "object")],
  "model-container.ts": [field("Node", "_internalMetadata")],
  "model-lod.ts": [referenced("InstancedMesh", "_currentLOD")],
  "multisample-present.ts": [
    referenced("Engine", "_gl"), field("Engine", "_currentFramebuffer", "null"), field("FrameGraphTask", "_frameGraph", "object"),
    referenced("InternalTexture", "_hardwareTexture"),
  ],
  "nearest-textures.ts": [field("SubMesh", "_drawWrappers", "array"), field("DrawWrapper", "_forceRebindOnNextCall", "boolean")],
  "node-handover.ts": [
    referenced("RuntimeAnimation", "_target"), referenced("RuntimeAnimation", "_activeTargets"), referenced("RuntimeAnimation", "_directTarget"),
    method("RuntimeAnimation", "_preparePath"),
  ],
  "node-material-particles.ts": [
    // `prepareNodeMaterialParticleBindings` throws on another arity.
    method("NodeMaterial", "_createEffectForParticles", 6), method("NodeMaterial", "_checkInternals"),
    referenced("ThinParticleSystem", "_customWrappers"), method("GPUParticleSystem", "_recreateUpdateEffect"),
    patched("NodeMaterial", "_createEffectForParticles", "the particle Effect is created in the material's shader language",
      ["particleSystem, this.shaderLanguage"]),
  ],
  "overlay-draw-batcher.ts": [
    field("Scene", "_blockEntityCollection", "boolean"), method("Mesh", "_getInstancesRenderList"), field("SubMesh", "_id", "number"),
    field("Mesh", "_instanceDataStorage", "object"), field("AbstractMesh", "_internalAbstractMeshDataInfo", "object"),
    field("AbstractMeshDataInfo", "_isActive", "boolean"), field("AbstractMeshDataInfo", "_isActiveIntermediate", "boolean"),
    referenced("Mesh", "_userInstancedBuffersStorage"), referenced("Mesh", "_occlusionDataStorage"),
  ],
  "overlay-visual-style.ts": [method("MaterialPluginBase", "_enable"), referenced("MaterialPluginBase", "_material")],
  "owned-effect-retirement.ts": [
    referenced("Effect", "_refCount"),
    // The same never-delete-a-linking-program rule, for wrappers Babylon disposes itself (render.md).
    patched("DrawWrapper", "dispose", "a deferred dispose keeps an Effect whose program still links until it settles", ["DisposeOnceLinked"]),
  ],
  "owned-post-process.ts": [method("Effect", "_isReadyInternal", 0), method("Effect", "_checkIsReady"), referenced("Effect", "_refCount"), referenced("PostProcess", "_effectWrapper")],
  "particle-graph-blocks.ts": [
    referenced("NodeParticleBlock", "_buildId"), method("ThinParticleSystem", "_fetchR", 5), referenced("Particle", "_properties"),
    field("NodeParticleConnectionPoint", "_storedFunction"), referenced("ThinParticleSystem", "_tempScaledUpdateSpeed"),
    referenced("ThinParticleSystem", "_updateQueueStart"),
  ],
  "particle-mesh-shape.ts": [
    ...referencedAll("ThinParticleSystem", "_positionCreation", "_directionCreation", "_colorCreation"), referenced("Particle", "_properties"),
  ],
  "particle-service.ts": [
    method("ThinParticleSystem", "_calculateEmitRate"), field("ThinParticleSystem", "_drawWrappers", "array"),
    referenced("GPUParticleSystem", "_platform"), referenced("WebGL2ParticleSystem", "_updateEffect"), referenced("Effect", "_refCount"),
    field("ThinParticleSystem", "_started", "boolean"),
  ],
  "particle-spawn.ts": [referenced("ThinParticleSystem", "_updateQueueStart"), field("ThinParticleSystem", "_actualFrame", "number")],
  "particle-sprite-sheet.ts": [
    accessor("ThinParticleSystem", "_isAnimationSheetEnabled", true), referenced("ThinParticleSystem", "_sheetCreation"),
    referenced("ThinParticleSystem", "_updateQueueStart"), referenced("Particle", "_properties"),
  ],
  "particle-system-factory.ts": [
    // `gpuInternals` throws on another layout.
    field("GPUParticleSystem", "_currentActiveCount", "number"), field("GPUParticleSystem", "_writePointer", "number"),
    field("GPUParticleSystem", "_refreshColorGradient", "function"), field("GPUParticleSystem", "_refreshFactorGradient", "function"),
    ...referencedAll("GPUParticleSystem", "_sizeGradientsTexture", "_angularSpeedGradientsTexture", "_velocityGradientsTexture",
      "_limitVelocityGradientsTexture", "_dragGradientsTexture"),
    field("GPUParticleSystem", "_currentRenderId", "number"), method("GPUParticleSystem", "_recreateUpdateEffect"),
    referenced("ThinParticleSystem", "_shadersLoaded"),
    patched("GPUParticleSystem", "animate", "`paused` holds the simulation", ["this.paused"]),
    patched("GPUParticleSystem", "render", "`paused` draws the last buffers without simulating", ["this.paused"]),
  ],
  "particle-update-compiler.ts": [
    field("ThinParticleSystem", "_actualFrame", "number"), referenced("ThinParticleSystem", "_scaledUpdateSpeed"),
    field("ParticleInputBlock", "_contextualSource", "number"), field("ParticleInputBlock", "_systemSource", "number"),
    field("NodeParticleConnectionPoint", "_storedFunction"), referenced("ThinParticleSystem", "_updateQueueStart"), referenced("Particle", "_properties"),
  ],
  "planar-mirror.ts": [
    field("Scene", "_blockEntityCollection", "boolean"), method("Camera", "_getViewMatrix", 0), field("RenderTargetTexture", "_objectRenderer", "object"),
    referenced("RenderTargetTexture", "_renderTarget"), field("BaseTexture", "_texture", "null"),
  ],
  "pooled-model-leaves.ts": [field("Node", "_internalMetadata")],
  "pose-bounds.ts": [field("AbstractMesh", "_masterMesh", "null")],
  "presented-frame.ts": [referenced("Engine", "_gl")],
  "reflected-content.ts": [
    referenced("Geometry", "_indexBufferIsUpdatable"), referenced("NodeMaterial", "_sharedData"), field("Mesh", "_thinInstanceDataStorage", "object"),
    referenced("Mesh", "_userThinInstanceBuffersStorage"),
  ],
  "reflection-probes.ts": [
    referenced("Scene", "_forcedViewPosition"), referenced("BaseTexture", "_prefiltered"), referenced("InternalTexture", "_sphericalPolynomial"),
    field("BaseTexture", "_texture", "null"),
  ],
  "reflection-sun-shadows.ts": [referenced("Camera", "_refreshFrustumPlanes")],
  "registered-view-admission.ts": [method("Engine", "_renderFrame"), method("Engine", "_renderViews", 0), method("Engine", "_renderViewStep", 1)],
  "render-change-journal.ts": [
    method("TransformNode", "_afterComputeWorldMatrix", 0), method("AbstractMesh", "_afterComputeWorldMatrix", 0),
    method("Node", "_syncParentEnabledState", 0), accessor("Node", "isVisible", true), accessor("Node", "inheritVisibility", true),
    accessor("AbstractMesh", "visibility", true), method("AbstractMesh", "_setMaterial", 1), method("AbstractMesh", "setMaterialForRenderPass", 2),
    accessor("AbstractMesh", "renderingGroupId", true), accessor("AbstractMesh", "layerMask", true), accessor("AbstractMesh", "hasVertexAlpha", true),
    method("Mesh", "addLODLevel"), method("Mesh", "removeLODLevel", 1), method("Geometry", "_notifyUpdate", 1), method("Geometry", "applyToMesh", 1),
    method("Geometry", "releaseForMesh", 2), method("Geometry", "setVerticesBuffer"), method("Geometry", "removeVerticesData", 1),
    method("Geometry", "setIndices"), method("Geometry", "setIndexBuffer"),
    field("Node", "_scene", "object"), field("Geometry", "_scene", "object"), field("Node", "_children", "null"),
    field("Node", "_nodeDataStorage", "object"), field("Geometry", "_meshes", "array"),
  ],
  "render-frame-report.ts": [field("Engine", "_drawCalls", "object")],
  "render-diagnostics.ts": [field("Engine", "_features", "object")],
  "render-target-capture.ts": [
    referenced("BaseTexture", "_gammaSpace"), method("SubMesh", "_getDrawWrapper"), field("RenderTargetTexture", "_objectRenderer", "object"),
    method("Geometry", "_releaseVertexArrayObject"), method("SubMesh", "_removeDrawWrapper"), field("BaseTexture", "_texture", "null"),
    field("DrawWrapper", "_wasPreviouslyReady", "boolean"),
  ],
  "render-target-resource-cost.ts": [
    referenced("WebGLHardwareTexture", "_MSAARenderBuffers"), referenced("WebGLRenderTargetWrapper", "_depthStencilBuffer"),
    referenced("RenderTargetWrapper", "_generateStencilBuffer"), referenced("InternalTexture", "_hardwareTexture"),
  ],
  "resource-cache.ts": [field("InternalTexture", "_references", "number"), field("InternalTexture", "_source", "number")],
  "sample-discard.ts": [
    referenced("WebGLRenderTargetWrapper", "_MSAAFramebuffer"), referenced("RenderTargetWrapper", "_generateStencilBuffer"), referenced("Engine", "_gl"),
  ],
  "scene-effects-graph.ts": referencedAll("ThinBloomEffect", "_downscale", "_blurX", "_blurY", "_merge"),
  "scene-game-time.ts": [referenced("Scene", "_animationTimeLast")],
  "scene-loader.ts": [statics("Mesh", "_GetDefaultSideOrientation", "function", 1), referenced("Mesh", "_originalBuilderSideOrientation")],
  "scene-perf.ts": [
    referenced("MaterialDefines", "_areLightsDisposed"), accessor("SubMesh", "_drawWrapperOverride"), method("SubMesh", "_getDrawWrapper"),
    method("Material", "_getDrawWrapper"), field("Scene", "_isReadyChecks", "array"), field("Scene", "_isReadyForMeshStage", "object"),
    field("Scene", "_pendingData", "array"), referenced("PushMaterial", "_renderId"), field("Material", "_storeEffectOnSubMeshes", "boolean"),
    field("DrawWrapper", "_wasPreviouslyReady", "boolean"),
  ],
  "scene-readiness-signal.ts": [referenced("Scene", "_activeCamera")],
  "scene-texture-references.ts": [referenced("Scene", "_ltcTextures")],
  "screen-shadows.ts": [field("FrameGraphTask", "_frameGraph", "object")],
  "shadow-allocation-validation.ts": [
    referenced("WebGLRenderTargetWrapper", "_depthStencilBuffer"), referenced("WebGLRenderTargetWrapper", "_framebuffer"),
    referenced("RenderTargetWrapper", "_generateStencilBuffer"), referenced("Engine", "_gl"), referenced("InternalTexture", "_hardwareTexture"),
  ],
  "shadow-atlas.ts": [
    method("ShadowGenerator", "_applyFilterValues", 0), method("RenderTargetTexture", "_bindFrameBuffer"), method("RenderTargetTexture", "_unbindFrameBuffer"),
    method("Engine", "_bindUnboundFramebuffer"), field("Scene", "_blockEntityCollection", "boolean"),
    field("ShadowGenerator", "_cachedDirection", "object"), field("ShadowGenerator", "_cachedPosition", "object"),
    ...referencedAll("CascadedShadowGenerator", "_cascadeMinExtents", "_cascadeMaxExtents", "_frustumLengths", "_viewSpaceFrustumsZ", "_numCascades",
      "_lightSizeUVCorrection", "_depthCorrection"),
    field("Engine", "_contextWasLost", "boolean"), method("ShadowGenerator", "_createTargetRenderTexture", 0), referenced("ShadowGenerator", "_currentFaceIndex"),
    field("Engine", "_currentFramebuffer", "null"), referenced("ShadowGenerator", "_currentRenderId"), field("Engine", "_currentRenderTarget", "null"),
    referenced("RenderTargetWrapper", "_depthStencilTexture"), field("Engine", "_features", "object"), field("ShadowGenerator", "_filter", "number"),
    referenced("WebGLRenderTargetWrapper", "_framebuffer"), method("ShadowGenerator", "_getCamera"), method("ShadowGenerator", "_initializeGenerator", 0),
    method("ShadowGenerator", "_initializeShadowMap", 0), field("Engine", "_integerMRTAttachmentsMask", "number"),
    method("ShadowGenerator", "_isReadyCustomDefines", 3), field("ShadowGenerator", "_light", "object"), method("Light", "_markMeshesAsLightDirty"),
    field("RenderTargetTexture", "_objectRenderer", "object"), field("ShadowGenerator", "_projectionMatrix", "object"),
    method("RenderTargetTexture", "_rebuild", 0), referenced("RenderTargetTexture", "_renderTarget"), field("ShadowGenerator", "_scene", "object"),
    field("Light", "_shadowGenerators"), field("ShadowGenerator", "_shadowMap", "object"), field("BaseTexture", "_texture", "null"),
    patched("CascadedShadowGenerator", "_computeMatrices", "each cascade snaps to its own tile size (`_cascadeMapSizes`)", ["_cascadeMapSizes"]),
  ],
  "shadow-controller.ts": [
    field("ObjectRenderer", "_currentRefreshId", "number"), field("RenderTargetTexture", "_objectRenderer", "object"),
    field("Engine", "_features", "object"), field("Scene", "_intermediateRendering", "boolean"), method("Light", "_markMeshesAsLightDirty"),
    method("RenderTargetTexture", "_shouldRender"),
  ],
  "shadow-map-factory.ts": [
    field("Scene", "_blockEntityCollection", "boolean"), field("RenderTargetTexture", "_objectRenderer", "object"),
    field("Light", "_shadowGenerators"), field("ShadowGenerator", "_shadowMap", "object"),
  ],
  "shadow-map-refresh.ts": [
    referenced("Scene", "_defaultMaterial"), referenced("Geometry", "_indexBufferIsUpdatable"), field("Mesh", "_thinInstanceDataStorage", "object"),
    referenced("Mesh", "_userThinInstanceBuffersStorage"),
  ],
  "shadow-material-policy.ts": [
    referenced("MaterialPluginManager", "_plugins"), field("Mesh", "_thinInstanceDataStorage", "object"),
    referenced("Mesh", "_userThinInstanceBuffersStorage"),
  ],
  "shadow-mesh-policy.ts": [
    accessor("Scene", "_hasDefaultMaterial"), field("AbstractMesh", "_internalAbstractMeshDataInfo", "object"),
    referenced("AbstractMesh", "_materialForRenderPass"),
  ],
  "shadow-retained-casters.ts": [
    field("Scene", "_activeIndices", "object"), field("ShadowGenerator", "_cachedDirection", "object"), field("ShadowGenerator", "_cachedPosition", "object"),
    field("Engine", "_drawCalls", "object"), method("Material", "_getEffectiveOrientation"), method("AbstractMesh", "_getWorldMatrixDeterminant"),
    method("ShadowGenerator", "_getCamera"), referenced("Engine", "_gl"), field("ShadowGenerator", "_prepareShadowDefines", "function"),
    method("Engine", "_releaseBuffer"), method("Engine", "_resetIndexBufferBinding"), method("Engine", "_resetVertexBufferBinding"),
    // Repeats the uniforms Babylon's own caster draw sets.
    field("ShadowGenerator", "_renderSubMeshForShadowMap", "function"),
  ],
  "shared-index-buffer.ts": [field("Geometry", "_indexBuffer")],
  "shared-outline-mask.ts": [
    field("PBRBaseMaterial", "_alphaCutOff", "number"), method("Mesh", "_bind"), method("SubMesh", "_getDrawWrapper"),
    method("Material", "_getEffectiveOrientation"), method("Mesh", "_getInstancesRenderList"), method("AbstractMesh", "_getWorldMatrixDeterminant"),
    field("SubMesh", "_id", "number"), field("AbstractMesh", "_internalAbstractMeshDataInfo", "object"), field("AbstractMeshDataInfo", "_isActiveIntermediate", "boolean"),
    field("PBRBaseMaterial", "_opacityTexture", "null"), field("StandardMaterial", "_opacityTexture", "null"),
    method("Mesh", "_processRendering"), method("Geometry", "_releaseVertexArrayObject"), method("SubMesh", "_removeDrawWrapper"),
    field("PBRBaseMaterial", "_useAlphaFresnel", "boolean"), field("PBRBaseMaterial", "_useAlphaFromAlbedoTexture", "boolean"),
  ],
  "shared-outline-task.ts": [field("FrameGraphTask", "_frameGraph", "object")],
  "shared-outline.ts": [
    field("DrawWrapper", "_forceRebindOnNextCall", "boolean"), method("SubMesh", "_getDrawWrapper"), field("AbstractMesh", "_masterMesh", "null"),
    method("Mesh", "_processInstancedBuffers", 2), referenced("Mesh", "_userInstancedBuffersStorage"), method("Mesh", "_invalidateInstanceVertexArrayObject"),
  ],
  "skybox.ts": [referenced("InternalTexture", "_sphericalPolynomial")],
  "spatial-effects-graph.ts": [field("FrameGraphTask", "_frameGraph", "object")],
  "starting-state-draw.ts": [field("SubMesh", "_drawWrappers", "array"), referenced("Effect", "_refCount")],
  "texture-quality.ts": [method("MaterialPluginBase", "_enable")],
  "transparent-depth-pre-pass.ts": [
    statics("RenderingGroup", "_RenderSorted", "function", 5), field("Scene", "_activeMeshesFrozenButKeepClipping", "boolean"),
    field("SubMesh", "_alphaIndex", "number"), field("SubMesh", "_distanceToCamera", "number"), referenced("Scene", "_frustumPlanes"),
    field("RenderingGroup", "_transparentSortCompareFn"),
  ],
  "unlit-material-blocks.ts": [referenced("Scene", "_mirroredCameraPosition")],
  "unlit-material.ts": [method("NodeMaterial", "_prepareDefinesForAttributes", 2), method("ImageProcessingConfiguration", "_updateParameters")],
  "variant-first-draws.ts": [field("Engine", "_compiledEffects", "object"), referenced("Effect", "_isDisposed")],
  "view-occlusion.ts": [method("SubMesh", "_getDrawWrapper")],
  "water-fft.ts": [referenced("Engine", "_gl")],
  "water-scene-copy.ts": [field("FrameGraphTask", "_frameGraph", "object"), field("FrameGraphTask", "_name", "string")],
  "webgl-call-timer.ts": [referenced("Engine", "_gl")],
  "webgl-draw-stub.ts": [referenced("Engine", "_gl"), field("Engine", "_compiledEffects", "object")],
};

const SOURCE_CACHE = new Map<string, string>();
const BABYLON = createRequire(import.meta.url).resolve("@babylonjs/core/package.json").slice(0, -"package.json".length);

/** The source of `owner`'s class and every class it extends, plus the extension modules that augment it. */
function ownerSource(name: OwnerName): string {
  let text = SOURCE_CACHE.get(name);
  if (text !== undefined) return text;
  const parts: string[] = [];
  for (let cls: unknown = OWNERS[name].cls; typeof cls === "function" && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
    parts.push(Function.prototype.toString.call(cls));
  }
  for (const file of EXTENSION_SOURCES[name] ?? []) parts.push(readFileSync(BABYLON + file, "utf8"));
  text = parts.join("\n");
  SOURCE_CACHE.set(name, text);
  return text;
}

function lookup(target: object, member: string): PropertyDescriptor | undefined {
  for (let at: object | null = target; at; at = Object.getPrototypeOf(at) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(at, member);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function typeOf(value: unknown): ValueType | "undefined" | "other" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "map";
  const type = typeof value;
  return type === "number" || type === "boolean" || type === "function" || type === "object" || type === "undefined" || type === "string"
    ? type : "other";
}

/** Why `row` does not hold, or null when it does. */
function violation(row: Row, instance: (owner: OwnerName) => object): string | null {
  const spec: OwnerSpec = OWNERS[row.owner];
  const prototype = spec.cls.prototype as object;
  switch (row.kind) {
    case "method": {
      const value = lookup(prototype, row.member)?.value as unknown;
      if (typeof value !== "function") return "is not a prototype method";
      if (row.arity !== undefined && (value as (...args: unknown[]) => unknown).length !== row.arity)
        return `takes ${(value as (...args: unknown[]) => unknown).length} parameters, not ${row.arity}`;
      return null;
    }
    case "static": {
      const value = lookup(spec.cls, row.member)?.value as unknown;
      if (typeOf(value) !== row.type) return `is ${typeOf(value)}, not a static ${row.type}`;
      if (row.arity !== undefined && (value as (...args: unknown[]) => unknown).length !== row.arity)
        return `takes ${(value as (...args: unknown[]) => unknown).length} parameters, not ${row.arity}`;
      return null;
    }
    case "accessor": {
      const descriptor = lookup(prototype, row.member);
      if (!descriptor?.get) return "is not a prototype getter";
      return row.setter && !descriptor.set ? "has no setter" : null;
    }
    case "field": {
      const object = instance(row.owner);
      if (!(row.member in object)) return "is not set on a new instance";
      const actual = typeOf((object as Record<string, unknown>)[row.member]);
      if (actual === "undefined" && !row.type) return null;
      return row.type && actual !== row.type ? `is ${actual} on a new instance, not ${row.type}` : null;
    }
    case "referenced":
      return new RegExp(`\\.${row.member}\\b`).test(ownerSource(row.owner)) ? null : "is not referenced by the class or its extensions";
    case "patched": {
      const value = lookup(prototype, row.member)?.value as unknown;
      if (typeof value !== "function") return "is not a prototype method";
      const source = Function.prototype.toString.call(value);
      const missing = row.has.filter((marker) => !source.includes(marker));
      const stale = (row.lacks ?? []).filter((marker) => source.includes(marker));
      if (missing.length || stale.length) return `lacks the patch (${row.why}): ${[...missing, ...stale.map((marker) => `still ${marker}`)].join(", ")}`;
      return null;
    }
  }
}

describe("Babylon 9.29 internals the renderer depends on", () => {
  let context: Context;
  const instances = new Map<OwnerName, object>();
  const instance = (owner: OwnerName): object => {
    let made = instances.get(owner);
    if (made) return made;
    const make = (OWNERS[owner] as OwnerSpec).make;
    if (!make) throw new Error(`${owner} has no instance factory for a field row; list the member as referenced instead`);
    made = make(context);
    instances.set(owner, made);
    return made;
  };

  beforeAll(() => {
    // NullEngine has no attachment layouts, which frame graph tasks build in their constructors.
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    const scene = new Scene(engine);
    context = {
      engine, scene, box: CreateBox("contract box", { size: 1 }, scene), frameGraph: new FrameGraph(scene),
      particles: new ParticleSystem("contract particles", 4, scene), light: new DirectionalLight("contract light", new Vector3(0, -1, 0), scene),
    };
  });
  afterAll(() => {
    vi.restoreAllMocks();
    context.engine.dispose();
  });

  it.each(Object.keys(INVENTORY))("%s", (file) => {
    const failures: string[] = [];
    for (const row of INVENTORY[file]!) {
      const reason = violation(row, instance);
      if (reason) failures.push(`${file} depends on Babylon ${row.owner}.${row.member} (${row.kind}), which ${reason}`);
    }
    expect(failures).toEqual([]);
  });
});

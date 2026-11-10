import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ImageProcessingBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/imageProcessingBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { InstancesBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/instancesBlock";
import { VertexOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/vertexOutputBlock";
import { AddBlock } from "@babylonjs/core/Materials/Node/Blocks/addBlock";
import { ColorMergerBlock } from "@babylonjs/core/Materials/Node/Blocks/colorMergerBlock";
import { TransformBlock } from "@babylonjs/core/Materials/Node/Blocks/transformBlock";
import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialSystemValues } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialSystemValues";
import { NodeMaterial, type NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { IImageProcessingConfigurationDefines } from "@babylonjs/core/Materials/imageProcessingConfiguration.defines";
import { PrepareDefinesForPrePass } from "@babylonjs/core/Materials/materialHelper.functions";
import { MaterialHelperGeometryRendering } from "@babylonjs/core/Materials/materialHelper.geometryrendering";
import { AuthoredShadowFragmentOutput, createAuthoredShadowVertexOutput } from "./authored-shadow-output";
import { createGeometryCaptureOutput } from "./geometry-capture-output";
import { HapticLightingBlock, followLightingDefines } from "./haptic-lighting-block";
import { applyLatticeDeformerPlumbing } from "./lattice-deformer-block";
import type { MaterialPlumbing } from "./material-block-registry";
import {
  LinearSurfaceImageProcessingBlock, registerAuthoredVariants, shareCompiledProgram,
  type AuthoredMaterialVariant, type AuthoredSurfaceVariant, type CompiledMaterial,
} from "./material-compiler";
import { overlayVisualStyle } from "./overlay-visual-style";
import { SceneFogBlock } from "./scene-fog-block";
import { registerCacheableShadowMaterial } from "./shadow-material-policy";
import { SharedOutlineIdentityBlock, SharedOutlineOutputBlock } from "./shared-outline-output-block";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import {
  UnlitFinishBlock, UnlitOutputBlock, UnlitSurfaceBlock, UnlitUvBlock, hasUnlitBinding,
  markPerMeshBindingMaterial, setMaterialUnlitBinding, setUnlitBinding, unlitBinding, type UnlitBinding,
} from "./unlit-material-blocks";
import { Light2DBlock, UnlitLinearColorBlock } from "./unlit-lighting-blocks";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";
import { registerAlphaToCoverage, samplesSteppedAlpha } from "./alpha-to-coverage";
import { drawBatchWorld } from "./draw-batch-world-block";

export type { UnlitBinding } from "./unlit-material-blocks";

/**
 * The render state an unlit Material instance carries (Babylon keeps it on the Material): every mesh drawing with the
 * same key shares one instance, and every instance with the same texturing (`textured`, `msdf`) shares one program.
 */
export type UnlitMaterialKey = {
  /** Samples the mesh's bound texture. */
  textured: boolean;
  /**
   * The bound texture is a multi-channel signed distance field (Text2D's MSDF atlas): the surface draws its glyph's
   * fill in the binding's colour and its outline in `UnlitBinding.msdf`'s. Requires `textured`.
   */
  msdf?: boolean;
  backFaceCulling: boolean;
  /** The scene's fog applies (editor helpers draw without it). */
  fog: boolean;
  /** Who draws it: world content, an editor helper, or a preview; instances of different roles never share state. */
  role: "world" | "helper" | "preview";
  /** The Scene's image processing (the default), or a tilemap atlas's exact display colours (`atlasImageProcessing`). */
  imageProcessing?: "scene" | "atlas";
  /** Draws its triangles' edges (a debug overlay's). */
  wireframe?: boolean;
  /**
   * Lights the colour: by the Scene's 2D lights (`lights-2d.ts`), or by its 3D lights through the light block
   * (`HapticLightingBlock`, a rough non-metal; Shading Mode 3D). Unset draws it unlit.
   */
  lighting?: "2d" | "3d";
};

/**
 * Tilemap atlases keep their exact display colors: the scene's tone mapping and exposure never apply to them. Under a
 * Scene Linear display stage they still decode to linear, like every unlit surface on the scene's configuration, so the
 * Display Color stage encodes them once.
 */
class AtlasImageProcessing extends ImageProcessingConfiguration {
  private readonly sceneConfiguration: ImageProcessingConfiguration;
  constructor(sceneConfiguration: ImageProcessingConfiguration) {
    super();
    this.sceneConfiguration = sceneConfiguration;
    this.isEnabled = false;
    sceneConfiguration.onUpdateParameters.add(() => this._updateParameters());
  }
  override prepareDefines(defines: IImageProcessingConfigurationDefines, forPostProcess = false): void {
    super.prepareDefines(defines, forPostProcess);
    defines.IMAGEPROCESSINGPOSTPROCESS = !forPostProcess && this.sceneConfiguration.applyByPostProcess;
  }
}
const atlasConfigurations = new WeakMap<Scene, AtlasImageProcessing>();

/** The Scene's tilemap atlas image processing (`UnlitMaterialKey.imageProcessing`). */
export function atlasImageProcessing(scene: Scene): AtlasImageProcessing {
  let configuration = atlasConfigurations.get(scene);
  if (!configuration) atlasConfigurations.set(scene, (configuration = new AtlasImageProcessing(scene.imageProcessingConfiguration)));
  return configuration;
}

type UnlitInstance = { material: NodeMaterial; key: UnlitMaterialKey; meshes: Set<AbstractMesh> };
const instances = new WeakMap<Scene, Map<string, UnlitInstance>>();
const instanceOf = new WeakMap<Material, UnlitInstance>();

/** Fixed block names: every instance's generated code is byte-identical, so `shareCompiledProgram` shares its program. */
const NAME = "unlit";

/** Whether the mesh's vertex colours carry alpha (Standard's `VERTEXALPHA`). */
function vertexAlpha(mesh: AbstractMesh): boolean {
  return mesh.hasVertexAlpha && mesh.useVertexColors && mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
}

/**
 * Standard's alpha rules, per mesh: an unlit instance draws opaque, alpha-tested and blended meshes alike, and Babylon
 * reads these for each draw.
 */
function unlitNeedsBlending(mesh: AbstractMesh): boolean {
  const binding = unlitBinding(mesh);
  const style = overlayVisualStyle(mesh);
  if (style.opacity * style.tint[3] < 1) return true;
  // Standard's alpha test blends only while the mesh fades (its alpha test and blend); alpha and vertex alpha it ignores.
  if (binding.cutoff > 0 && !binding.blend) return mesh.visibility > 0 && mesh.visibility < 1;
  return binding.blend || binding.alpha < 1 || mesh.visibility < 1 || vertexAlpha(mesh);
}

function matrixInput(name: string, value: NodeMaterialSystemValues, blocks: NodeMaterialBlock[]): InputBlock {
  // Babylon's floating-origin adapter recognizes the system matrix prefix.
  const block = new InputBlock(`${NodeMaterialSystemValues[value]}_${name}`, undefined, Types.Matrix);
  block.setAsSystemValue(value);
  blocks.push(block);
  return block;
}

/** What a surface samples (nothing, the bound texture, or the bound texture as an MSDF atlas) and how it is lit. */
type SurfaceKind = { textured: boolean; msdf: boolean; lighting: "2d" | "3d" | null };

function surfaceKind(key: UnlitMaterialKey): SurfaceKind {
  return { textured: key.textured, msdf: key.textured && key.msdf === true, lighting: key.lighting ?? null };
}

/**
 * The surface's colour graph: position, UV and colour; lattice-deformable through a constant normal, or, lit in 3D,
 * through the mesh's own.
 */
function buildSurface(material: NodeMaterial, { textured, msdf, lighting }: SurfaceKind, blocks: NodeMaterialBlock[]): void {
  const scene = material.getScene();
  const position = new InputBlock(`${NAME}_position`, undefined, Types.Vector3);
  position.setAsAttribute("position");
  const color = new InputBlock(`${NAME}_color`, undefined, Types.Color4);
  color.setAsAttribute("color");
  const world = matrixInput(`${NAME}_world`, NodeMaterialSystemValues.World, blocks);
  const instancesBlock = new InstancesBlock(`${NAME}_instances`);
  world.output.connectTo(instancesBlock.world);
  // What every transform reads: a draw batch's mesh carries its members' world matrices per vertex.
  const drawWorld = drawBatchWorld(NAME, instancesBlock, blocks);
  const view = matrixInput(`${NAME}_view`, NodeMaterialSystemValues.View, blocks);
  const viewProjection = matrixInput(`${NAME}_viewProjection`, NodeMaterialSystemValues.ViewProjection, blocks);
  const worldPosition = new TransformBlock(`${NAME}_worldPos`);
  position.output.connectTo(worldPosition.vector);
  drawWorld.connectTo(worldPosition.transform);
  // The lattice deformer moves positions; unlit has no normal, so it deforms a constant one nothing reads.
  const normal = new InputBlock(`${NAME}_normal`, undefined, Types.Vector4);
  normal.value = new Vector4(0, 1, 0, 0);
  blocks.push(position, color, instancesBlock, worldPosition, normal);
  const plumbing: MaterialPlumbing = { worldPosition: worldPosition.output, worldNormal4: normal.output };
  if (lighting === "3d") {
    const meshNormal = new InputBlock(`${NAME}_meshNormal`, undefined, Types.Vector3);
    meshNormal.setAsAttribute("normal");
    const worldNormal = new TransformBlock(`${NAME}_worldNormal`);
    worldNormal.complementW = 0;
    meshNormal.output.connectTo(worldNormal.vector);
    drawWorld.connectTo(worldNormal.transform);
    blocks.push(meshNormal, worldNormal);
    plumbing.worldNormal4 = worldNormal.output;
  }
  applyLatticeDeformerPlumbing(NAME, blocks, plumbing, scene);
  const finalPosition = plumbing.worldPosition!;
  const clip = new TransformBlock(`${NAME}_clipPos`);
  finalPosition.connectTo(clip.vector);
  viewProjection.output.connectTo(clip.transform);
  const vertexOutput = new VertexOutputBlock(`${NAME}_vertexOutput`);
  clip.output.connectTo(vertexOutput.vector);
  blocks.push(clip, vertexOutput);

  const surface = new UnlitSurfaceBlock(`${NAME}_surface`);
  surface.coverage = true;
  surface.textured = textured;
  surface.msdf = msdf;
  if (textured) {
    const uv = new InputBlock(`${NAME}_uv`, undefined, Types.Vector2);
    uv.setAsAttribute("uv");
    const transformed = new UnlitUvBlock(`${NAME}_uvTransform`);
    uv.output.connectTo(transformed.uv);
    transformed.output.connectTo(surface.uv);
    blocks.push(uv, transformed);
  }
  color.output.connectTo(surface.vertexColor);
  finalPosition.connectTo(surface.worldPosition);
  // Per vertex, as Standard's fog distance and view depth are.
  const viewPosition = new TransformBlock(`${NAME}_viewPos`);
  finalPosition.connectTo(viewPosition.vector);
  view.output.connectTo(viewPosition.transform);
  const fog = new SceneFogBlock(`${NAME}_fog`);
  // Unlit and 2D-lit colours stay in display space, as Standard's unlit pixels do; 3D-lit ones are linear.
  fog.displaySpace = lighting !== "3d";
  litColor(surface, finalPosition, plumbing, lighting, blocks).connectTo(fog.input);
  finalPosition.connectTo(fog.worldPosition);
  view.output.connectTo(fog.view);
  viewPosition.output.connectTo(fog.viewPosition);
  // Standard's colour carries its alpha through fog and image processing, which leave it as it is.
  const merge = new ColorMergerBlock(`${NAME}_rgba`);
  fog.output.connectTo(merge.rgbIn);
  surface.a.connectTo(merge.a);
  // A 3D-lit colour is linear: it goes through image processing as a lit Material surface's does.
  const imageProcessing = lighting === "3d" ? new LinearSurfaceImageProcessingBlock(`${NAME}_imageProcessing`) : new ImageProcessingBlock(`${NAME}_imageProcessing`);
  imageProcessing.convertInputToLinearSpace = lighting !== "3d";
  merge.rgba.connectTo(imageProcessing.color);
  const finish = new UnlitFinishBlock(`${NAME}_finish`);
  imageProcessing.output.connectTo(finish.input);
  const output = new UnlitOutputBlock(`${NAME}_output`);
  finish.output.connectTo(output.rgba);
  viewPosition.output.connectTo(output.geometryViewPosition);
  surface.faceNormal.connectTo(output.geometryNormal);
  const camera = new InputBlock(`${NAME}_camera`);
  camera.setAsSystemValue(NodeMaterialSystemValues.CameraParameters);
  camera.output.connectTo(output.geometryCamera);
  blocks.push(surface, fog, merge, imageProcessing, finish, output, viewPosition, camera);
  material.addOutputNode(vertexOutput);
  material.addOutputNode(output);
}

/**
 * The surface's colour as lit: unlit as it is; 2D-lit times the Scene's 2D light at its XY (display space); 3D-lit as a
 * rough non-metal through the light block, from its colour decoded to linear (the light block's direct and environment
 * light summed).
 */
function litColor(
  surface: UnlitSurfaceBlock, worldPosition: NodeMaterialConnectionPoint, plumbing: MaterialPlumbing,
  lighting: SurfaceKind["lighting"], blocks: NodeMaterialBlock[],
): NodeMaterialConnectionPoint {
  if (lighting === "2d") {
    const light = new Light2DBlock(`${NAME}_light2D`);
    surface.rgb.connectTo(light.color);
    worldPosition.connectTo(light.worldPosition);
    blocks.push(light);
    return light.output;
  }
  if (lighting !== "3d") return surface.rgb;
  const linear = new UnlitLinearColorBlock(`${NAME}_linearColor`);
  surface.rgb.connectTo(linear.input);
  const camera = new InputBlock(`${NAME}_cameraPosition`, undefined, Types.Vector3);
  camera.setAsSystemValue(NodeMaterialSystemValues.CameraPosition);
  const metallic = new InputBlock(`${NAME}_metallic`, undefined, Types.Float);
  metallic.value = 0;
  const roughness = new InputBlock(`${NAME}_roughness`, undefined, Types.Float);
  roughness.value = 1;
  const lightingBlock = new HapticLightingBlock(`${NAME}_lighting`);
  worldPosition.connectTo(lightingBlock.worldPosition);
  plumbing.worldNormal4!.connectTo(lightingBlock.worldNormal);
  camera.output.connectTo(lightingBlock.cameraPosition);
  linear.output.connectTo(lightingBlock.baseColor);
  metallic.output.connectTo(lightingBlock.metallic);
  roughness.output.connectTo(lightingBlock.roughness);
  const direct = new AddBlock(`${NAME}_direct`);
  lightingBlock.diffuseDirect.connectTo(direct.left);
  lightingBlock.specularDirect.connectTo(direct.right);
  const indirect = new AddBlock(`${NAME}_indirect`);
  lightingBlock.diffuseIndirect.connectTo(indirect.left);
  lightingBlock.specularIndirect.connectTo(indirect.right);
  const total = new AddBlock(`${NAME}_lit`);
  direct.output.connectTo(total.left);
  indirect.output.connectTo(total.right);
  blocks.push(linear, camera, metallic, roughness, lightingBlock, direct, indirect, total);
  return total.output;
}

/** A pass variant's graph: the coverage of the surface (its texture, alpha and cutoff) over the shared surface plumbing. */
function buildVariant(material: NodeMaterial, { textured, msdf }: SurfaceKind, kind: AuthoredSurfaceVariant, owner: NodeMaterial, blocks: NodeMaterialBlock[]): void {
  const scene = material.getScene();
  const name = `${NAME}_${kind}`;
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing(name, blocks, plumbing);
  applyLatticeDeformerPlumbing(name, blocks, plumbing, scene);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const surface = new UnlitSurfaceBlock(`${name}_surface`);
  surface.textured = textured;
  surface.msdf = msdf;
  surface.alphaOwner = owner;
  if (textured) {
    const transformed = new UnlitUvBlock(`${name}_uvTransform`);
    plumbing.uv!.connectTo(transformed.uv);
    transformed.output.connectTo(surface.uv);
    blocks.push(transformed);
  }
  const color = new InputBlock(`${name}_color`, undefined, Types.Color4);
  color.setAsAttribute("color");
  color.output.connectTo(surface.vertexColor);
  plumbing.worldPosition!.connectTo(surface.worldPosition);
  blocks.push(surface, color);
  if (kind === "outlineMask") {
    const identity = new SharedOutlineIdentityBlock(`${name}_identity`);
    const output = new SharedOutlineOutputBlock(`${name}_outline`);
    identity.identity.connectTo(output.rgb);
    surface.a.connectTo(output.a);
    blocks.push(identity, output);
    outputs.push(output);
  } else if (kind === "shadowDepth") {
    // The shadow pass owns the final projection, so native normal bias applies after deformation.
    outputs.length = 0;
    outputs.push(createAuthoredShadowVertexOutput(name, blocks, plumbing));
    const output = new AuthoredShadowFragmentOutput(`${name}_shadowFragment`);
    surface.a.connectTo(output.opacity);
    blocks.push(output);
    outputs.push(output);
  } else {
    outputs.push(createGeometryCaptureOutput(scene, kind === "captureDepth", blocks, plumbing));
    // The capture writes geometry only; the surface's discard is its coverage.
    outputs.push(surface);
  }
  for (const output of outputs) material.addOutputNode(output);
}

function createNodeMaterial(scene: Scene, name: string): NodeMaterial {
  const material = new NodeMaterial(name, scene, {
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  if (scene.getEngine().isWebGPU) rebindEmptiedDrawContexts(material);
  material.allowShaderHotSwapping = false;
  return material;
}

/**
 * Rebinds per-mesh blocks for each draw of a frozen material, which Babylon skips when another mesh shared the effect:
 * the surface, the lattice, the 2D light block's binding point and the light block's receiver terms.
 */
function rebindPerMesh(material: NodeMaterial): void {
  const perMesh = material.attachedBlocks.filter((block) =>
    block instanceof UnlitSurfaceBlock || block instanceof Light2DBlock || block.getClassName() === "LatticeDeformerBlock");
  const lighting = material.attachedBlocks.filter((block): block is HapticLightingBlock => block instanceof HapticLightingBlock);
  material.onBindObservable.add((mesh) => {
    if (!material.isFrozen) return;
    const effect = material.getEffect();
    if (!effect) return;
    for (const block of perMesh) block.bind(effect, material, mesh as Mesh);
    for (const block of lighting) block.bindReceiver(effect, mesh);
  });
}

/**
 * Babylon sets NORMAL, TANGENT, UV1 to UV6 and VERTEXCOLOR_NME from each mesh's attributes, which would split one unlit
 * program by vertex layout. The surface reads none but UV1 (when textured), the vertex colour and, lit in 3D, the normal.
 */
function pinAttributeDefines(material: NodeMaterial, textured: boolean, normals = false): void {
  const scene = material.getScene();
  (material as unknown as { _prepareDefinesForAttributes: (mesh: AbstractMesh, defines: NodeMaterialDefines) => void })
    ._prepareDefinesForAttributes = (mesh, defines) => {
      const before = ["NORMAL", "TANGENT", "VERTEXCOLOR_NME", "UV1", "UV2", "UV3", "UV4", "UV5", "UV6"].map((name) => defines[name]);
      defines["NORMAL"] = normals && mesh.isVerticesDataPresent(VertexBuffer.NormalKind);
      defines["TANGENT"] = false;
      defines["VERTEXCOLOR_NME"] = mesh.useVertexColors && mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
      defines["UV1"] = textured && mesh.isVerticesDataPresent(VertexBuffer.UVKind);
      for (let index = 2; index <= 6; index++) defines[`UV${index}`] = false;
      // As Babylon's own: the geometry pass's defines.
      const oit = material.needAlphaBlendingForMesh(mesh) && scene.useOrderIndependentTransparency;
      PrepareDefinesForPrePass(scene, defines, !oit);
      MaterialHelperGeometryRendering.PrepareDefines(scene.getEngine().currentRenderPassId, mesh, defines);
      if (["NORMAL", "TANGENT", "VERTEXCOLOR_NME", "UV1", "UV2", "UV3", "UV4", "UV5", "UV6"].some((name, index) => defines[name] !== before[index]))
        defines.markAsAttributesDirty();
    };
}

/** A variant as the passes that acquire one hold it (`AuthoredMaterialVariant`); it has no parameters. */
function variantCompiled(material: NodeMaterial): CompiledMaterial {
  const dispose = () => { if (!material.getScene().materials.includes(material)) return; material.dispose(false, false); };
  return {
    ok: true, material, ready: Promise.resolve([]), buildState: "ready",
    setParameter: () => false, getParameter: () => null, resetParameter: () => false,
    dispose, whenReleased: () => { dispose(); return Promise.resolve(); },
  };
}

function createVariant(owner: NodeMaterial, surface: SurfaceKind, kind: AuthoredSurfaceVariant): NodeMaterial {
  const scene = owner.getScene();
  const material = createNodeMaterial(scene, `${owner.name}:${kind}`);
  material.backFaceCulling = owner.backFaceCulling;
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.alphaMode = Constants.ALPHA_DISABLE;
  const blocks: NodeMaterialBlock[] = [];
  buildVariant(material, surface, kind, owner, blocks);
  rebindPerMesh(material);
  shareCompiledProgram(material, JSON.stringify([NAME, kind, surface.textured, surface.msdf, material.shaderLanguage]));
  material.onDisposeObservable.addOnce(() => { for (const block of blocks) block.dispose(); });
  material.build();
  return material;
}

function instanceId(key: UnlitMaterialKey): string {
  return JSON.stringify([key.textured, key.msdf === true, key.backFaceCulling, key.fog, key.role, key.imageProcessing ?? "scene", key.wireframe === true, key.lighting ?? null]);
}

function createInstance(scene: Scene, key: UnlitMaterialKey, owned = false): UnlitInstance {
  const material = createNodeMaterial(scene, `unlit:${key.role}${key.msdf ? ":msdf" : key.textured ? ":textured" : ""}${key.fog ? "" : ":noFog"}${key.backFaceCulling ? "" : ":twoSided"}${key.lighting ? `:lit${key.lighting.toUpperCase()}` : ""}`);
  const instance: UnlitInstance = { material, key: { ...key }, meshes: new Set() };
  if (!owned) {
    // Shared by every mesh with its key: a mesh disposed with its materials (`dispose(false, true)`) leaves it to the
    // others. The Scene disposes it, after notifying its dispose observers.
    let sceneDisposing = false;
    scene.onDisposeObservable.addOnce(() => { sceneDisposing = true; });
    const dispose = material.dispose.bind(material);
    material.dispose = (...args: Parameters<NodeMaterial["dispose"]>) => { if (sceneDisposing) dispose(...args); };
  }
  material.backFaceCulling = key.backFaceCulling;
  material.fogEnabled = key.fog;
  if (key.imageProcessing === "atlas") material.imageProcessingConfiguration = atlasImageProcessing(scene);
  if (key.wireframe) material.wireframe = true;
  material.needAlphaBlending = () => false;
  material.needAlphaTesting = () => false;
  material.needAlphaBlendingForMesh = (mesh) => unlitNeedsBlending(mesh);
  material.needAlphaTestingForMesh = (mesh) => { const binding = unlitBinding(mesh); return binding.cutoff > 0 && !binding.blend; };
  // An alpha-tested mesh's colour draws write alpha-to-coverage under MSAA, unless its texture's alpha steps (pixel art).
  registerAlphaToCoverage(material, (mesh) => material.needAlphaTestingForMesh(mesh) && !samplesSteppedAlpha(unlitBinding(mesh).texture));
  const activeTextures = material.getActiveTextures.bind(material);
  material.getActiveTextures = () => {
    const textures = activeTextures();
    for (const mesh of instance.meshes) {
      const texture = unlitBinding(mesh).texture;
      if (texture && !textures.includes(texture)) textures.push(texture);
    }
    return textures;
  };
  const hasTexture = material.hasTexture.bind(material);
  material.hasTexture = (texture: BaseTexture) => hasTexture(texture) || [...instance.meshes].some((mesh) => unlitBinding(mesh).texture === texture);
  pinAttributeDefines(material, key.textured, key.lighting === "3d");
  const blocks: NodeMaterialBlock[] = [];
  const kind = surfaceKind(key);
  buildSurface(material, kind, blocks);
  rebindPerMesh(material);
  // CEL and Screen-Space Shadows are the light block's scene-level defines, set from the Scene's settings.
  if (kind.lighting === "3d") followLightingDefines(material);
  shareCompiledProgram(material, JSON.stringify([NAME, "surface", kind.textured, kind.msdf, kind.lighting, material.shaderLanguage]));
  // Opaque unlit meshes keep the cached stock shadow path. Registered with the build's final id (the build finishes
  // once its blocks' shader code has loaded), after the bind observers it snapshots.
  material.onBuildObservable.addOnce(() => registerCacheableShadowMaterial(material));
  material.build();
  const variants = new Map<AuthoredSurfaceVariant, { material: NodeMaterial; references: number }>();
  const registration = registerAuthoredVariants(material, (kind): AuthoredMaterialVariant => {
    let variant = variants.get(kind);
    if (!variant) variants.set(kind, (variant = { material: createVariant(material, surfaceKind(key), kind), references: 0 }));
    const retained = variant;
    retained.references++;
    let released = false;
    return {
      compiled: variantCompiled(retained.material),
      release: async () => {
        if (released) return;
        released = true;
        if (--retained.references === 0 && variants.get(kind) === retained) {
          variants.delete(kind);
          retained.material.dispose(false, false);
        }
      },
    };
  });
  material.onDisposeObservable.addOnce(() => {
    registration.unregister();
    for (const variant of variants.values()) variant.material.dispose(false, false);
    variants.clear();
    for (const block of blocks) block.dispose();
    const map = instances.get(scene);
    if (map?.get(instanceId(key)) === instance) map.delete(instanceId(key));
  });
  instanceOf.set(material, instance);
  markPerMeshBindingMaterial(material);
  return instance;
}

/** The Scene's unlit Material for `key`, created on first use and shared by every mesh drawing with that key. */
export function unlitMaterial(scene: Scene, key: UnlitMaterialKey): NodeMaterial {
  let map = instances.get(scene);
  if (!map) instances.set(scene, (map = new Map()));
  const id = instanceId(key);
  let instance = map.get(id);
  if (!instance) map.set(id, (instance = createInstance(scene, key)));
  return instance.material;
}

/**
 * An unlit Material of its own, whose binding every mesh drawing it shares: for owners that swap whole materials on
 * their meshes, as Babylon's gizmos do on hover. Its owner disposes it; it shares the program of its key's texturing.
 */
export function ownedUnlitMaterial(scene: Scene, key: UnlitMaterialKey, binding: UnlitBinding): NodeMaterial {
  const { material } = createInstance(scene, key, true);
  setMaterialUnlitBinding(material, binding);
  return material;
}

/** Whether `material` is an unlit Material instance. */
export function isUnlitMaterial(material: Material | null | undefined): material is NodeMaterial {
  return !!material && instanceOf.has(material);
}

const tracked = new WeakSet<AbstractMesh>();

/**
 * Draws `mesh` with the unlit Material for `key`, bound to `binding`: what it samples and its colour, alpha and cutoff.
 * The caller keeps any texture's lease; a later call rebinds the same mesh (a new texture, colour or key).
 */
export function setUnlitMaterial(mesh: AbstractMesh, key: UnlitMaterialKey, binding: UnlitBinding): NodeMaterial {
  const material = unlitMaterial(mesh.getScene(), key);
  const previous = mesh.material && instanceOf.get(mesh.material);
  if (previous && previous.material !== material) previous.meshes.delete(mesh);
  setUnlitBinding(mesh, binding);
  instanceOf.get(material)!.meshes.add(mesh);
  if (mesh.material !== material) mesh.material = material;
  if (!tracked.has(mesh)) {
    tracked.add(mesh);
    mesh.onDisposeObservable.addOnce(() => {
      const current = mesh.material && instanceOf.get(mesh.material);
      current?.meshes.delete(mesh);
    });
  }
  return material;
}

/** Draws `target` as `source` draws: its unlit Material and binding, or its other material. */
export function copyMaterialOf(target: AbstractMesh, source: AbstractMesh): void {
  const instance = source.material && instanceOf.get(source.material);
  if (instance && hasUnlitBinding(source)) setUnlitMaterial(target, instance.key, unlitBinding(source));
  else target.material = source.material;
}

/** Captures how `mesh` draws now (its unlit Material and binding, or its other material) and returns its restore. */
export function materialRestore(mesh: AbstractMesh): () => void {
  const material = mesh.material;
  const instance = material && instanceOf.get(material);
  if (instance && hasUnlitBinding(mesh)) {
    const binding = unlitBinding(mesh);
    return () => { setUnlitMaterial(mesh, instance.key, binding); };
  }
  return () => { mesh.material = material; };
}

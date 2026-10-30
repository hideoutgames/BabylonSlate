import {
  ColorMergerBlock, Constants, ImageProcessingBlock, ImageProcessingConfiguration, InputBlock, InstancesBlock, Material, NodeMaterial,
  NodeMaterialBlockConnectionPointTypes as Types, NodeMaterialSystemValues, ShaderLanguage, TransformBlock,
  Vector4, VertexBuffer, VertexOutputBlock,
  type AbstractMesh, type BaseTexture, type Mesh, type NodeMaterialBlock, type NodeMaterialDefines, type Scene,
} from "@babylonjs/core";
import type { IImageProcessingConfigurationDefines } from "@babylonjs/core/Materials/imageProcessingConfiguration.defines";
import { PrepareDefinesForPrePass } from "@babylonjs/core/Materials/materialHelper.functions";
import { MaterialHelperGeometryRendering } from "@babylonjs/core/Materials/materialHelper.geometryrendering";
import { AuthoredShadowFragmentOutput, createAuthoredShadowVertexOutput } from "./authored-shadow-output";
import { createGeometryCaptureOutput } from "./geometry-capture-output";
import { applyLatticeDeformerPlumbing } from "./lattice-deformer-block";
import type { MaterialPlumbing } from "./material-block-registry";
import {
  registerAuthoredVariants, shareCompiledProgram,
  type AuthoredMaterialVariant, type AuthoredSurfaceVariant, type CompiledMaterial,
} from "./material-compiler";
import { overlayVisualStyle } from "./overlay-visual-style";
import { SceneFogBlock } from "./scene-fog-block";
import { registerCacheableShadowMaterial } from "./shadow-material-policy";
import { SharedOutlineIdentityBlock, SharedOutlineOutputBlock } from "./shared-outline-output-block";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import {
  UnlitFinishBlock, UnlitOutputBlock, UnlitSurfaceBlock, UnlitUvBlock, UnlitVelocityBlock, hasUnlitBinding,
  setUnlitBinding, unlitBinding, type UnlitBinding,
} from "./unlit-material-blocks";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";

export type { UnlitBinding } from "./unlit-material-blocks";

/**
 * The render state an unlit Material instance carries (Babylon keeps it on the Material): every mesh drawing with the
 * same key shares one instance, and every instance with the same `textured` shares one program.
 */
export type UnlitMaterialKey = {
  /** Samples the mesh's bound texture. */
  textured: boolean;
  backFaceCulling: boolean;
  /** The scene's fog applies (editor helpers draw without it). */
  fog: boolean;
  /** Who draws it: world content, an editor helper, or a preview; instances of different roles never share state. */
  role: "world" | "helper" | "preview";
  /** The Scene's image processing (the default), or a tilemap atlas's exact display colours (`atlasImageProcessing`). */
  imageProcessing?: "scene" | "atlas";
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
export function unlitNeedsBlending(mesh: AbstractMesh): boolean {
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

/** The surface's colour graph: position, UV and colour only; lattice-deformable through a constant normal. */
function buildSurface(material: NodeMaterial, textured: boolean, blocks: NodeMaterialBlock[]): void {
  const scene = material.getScene();
  const position = new InputBlock(`${NAME}_position`, undefined, Types.Vector3);
  position.setAsAttribute("position");
  const color = new InputBlock(`${NAME}_color`, undefined, Types.Color4);
  color.setAsAttribute("color");
  const world = matrixInput(`${NAME}_world`, NodeMaterialSystemValues.World, blocks);
  const instancesBlock = new InstancesBlock(`${NAME}_instances`);
  world.output.connectTo(instancesBlock.world);
  const view = matrixInput(`${NAME}_view`, NodeMaterialSystemValues.View, blocks);
  const viewProjection = matrixInput(`${NAME}_viewProjection`, NodeMaterialSystemValues.ViewProjection, blocks);
  const worldPosition = new TransformBlock(`${NAME}_worldPos`);
  position.output.connectTo(worldPosition.vector);
  instancesBlock.output.connectTo(worldPosition.transform);
  // The lattice deformer moves positions; unlit has no normal, so it deforms a constant one nothing reads.
  const normal = new InputBlock(`${NAME}_normal`, undefined, Types.Vector4);
  normal.value = new Vector4(0, 1, 0, 0);
  blocks.push(position, color, instancesBlock, worldPosition, normal);
  const plumbing: MaterialPlumbing = { worldPosition: worldPosition.output, worldNormal4: normal.output };
  applyLatticeDeformerPlumbing(NAME, blocks, plumbing, scene);
  const finalPosition = plumbing.worldPosition!;
  const clip = new TransformBlock(`${NAME}_clipPos`);
  finalPosition.connectTo(clip.vector);
  viewProjection.output.connectTo(clip.transform);
  const vertexOutput = new VertexOutputBlock(`${NAME}_vertexOutput`);
  clip.output.connectTo(vertexOutput.vector);
  blocks.push(clip, vertexOutput);

  const surface = new UnlitSurfaceBlock(`${NAME}_surface`);
  surface.textured = textured;
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
  fog.displaySpace = true;
  surface.rgb.connectTo(fog.input);
  finalPosition.connectTo(fog.worldPosition);
  view.output.connectTo(fog.view);
  viewPosition.output.connectTo(fog.viewPosition);
  // Standard's colour carries its alpha through fog and image processing, which leave it as it is.
  const merge = new ColorMergerBlock(`${NAME}_rgba`);
  fog.output.connectTo(merge.rgbIn);
  surface.a.connectTo(merge.a);
  const imageProcessing = new ImageProcessingBlock(`${NAME}_imageProcessing`);
  imageProcessing.convertInputToLinearSpace = true;
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
  const velocity = new UnlitVelocityBlock(`${NAME}_velocity`);
  position.output.connectTo(velocity.position);
  finalPosition.connectTo(velocity.worldPosition);
  viewProjection.output.connectTo(velocity.viewProjection);
  velocity.current.connectTo(output.velocityCurrent);
  velocity.previous.connectTo(output.velocityPrevious);
  blocks.push(surface, fog, merge, imageProcessing, finish, output, viewPosition, camera, velocity);
  material.addOutputNode(vertexOutput);
  material.addOutputNode(output);
}

/** A pass variant's graph: the coverage of the surface (its texture, alpha and cutoff) over the shared surface plumbing. */
function buildVariant(material: NodeMaterial, textured: boolean, kind: AuthoredSurfaceVariant, owner: NodeMaterial, blocks: NodeMaterialBlock[]): void {
  const scene = material.getScene();
  const name = `${NAME}_${kind}`;
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing(name, blocks, plumbing);
  applyLatticeDeformerPlumbing(name, blocks, plumbing, scene);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const surface = new UnlitSurfaceBlock(`${name}_surface`);
  surface.textured = textured;
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

/** Rebinds per-mesh blocks for each draw of a frozen material, which Babylon skips when another mesh shared the effect. */
function rebindPerMesh(material: NodeMaterial): void {
  const perMesh = material.attachedBlocks.filter((block) => block instanceof UnlitSurfaceBlock || block.getClassName() === "LatticeDeformerBlock");
  material.onBindObservable.add((mesh) => {
    if (!material.isFrozen) return;
    const effect = material.getEffect();
    if (effect) for (const block of perMesh) block.bind(effect, material, mesh as Mesh);
  });
}

/**
 * Babylon sets NORMAL, TANGENT, UV1 to UV6 and VERTEXCOLOR_NME from each mesh's attributes, which would split one unlit
 * program by vertex layout. The surface reads none but UV1 (when textured) and the vertex colour.
 */
function pinAttributeDefines(material: NodeMaterial, textured: boolean): void {
  const scene = material.getScene();
  (material as unknown as { _prepareDefinesForAttributes: (mesh: AbstractMesh, defines: NodeMaterialDefines) => void })
    ._prepareDefinesForAttributes = (mesh, defines) => {
      const before = ["NORMAL", "TANGENT", "VERTEXCOLOR_NME", "UV1", "UV2", "UV3", "UV4", "UV5", "UV6"].map((name) => defines[name]);
      defines["NORMAL"] = false;
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

function createVariant(owner: NodeMaterial, textured: boolean, kind: AuthoredSurfaceVariant): NodeMaterial {
  const scene = owner.getScene();
  const material = createNodeMaterial(scene, `${owner.name}:${kind}`);
  material.backFaceCulling = owner.backFaceCulling;
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.alphaMode = Constants.ALPHA_DISABLE;
  const blocks: NodeMaterialBlock[] = [];
  buildVariant(material, textured, kind, owner, blocks);
  rebindPerMesh(material);
  shareCompiledProgram(material, JSON.stringify([NAME, kind, textured, material.shaderLanguage]));
  material.onDisposeObservable.addOnce(() => { for (const block of blocks) block.dispose(); });
  material.build();
  return material;
}

function instanceId(key: UnlitMaterialKey): string {
  return JSON.stringify([key.textured, key.backFaceCulling, key.fog, key.role, key.imageProcessing ?? "scene"]);
}

function createInstance(scene: Scene, key: UnlitMaterialKey): UnlitInstance {
  const material = createNodeMaterial(scene, `unlit:${key.role}${key.textured ? ":textured" : ""}${key.fog ? "" : ":noFog"}${key.backFaceCulling ? "" : ":twoSided"}`);
  const instance: UnlitInstance = { material, key: { ...key }, meshes: new Set() };
  // Shared by every mesh with its key: a mesh disposed with its materials (`dispose(false, true)`) leaves it to the
  // others. The Scene disposes it, after notifying its dispose observers.
  let sceneDisposing = false;
  scene.onDisposeObservable.addOnce(() => { sceneDisposing = true; });
  const dispose = material.dispose.bind(material);
  material.dispose = (...args: Parameters<NodeMaterial["dispose"]>) => { if (sceneDisposing) dispose(...args); };
  material.backFaceCulling = key.backFaceCulling;
  material.fogEnabled = key.fog;
  if (key.imageProcessing === "atlas") material.imageProcessingConfiguration = atlasImageProcessing(scene);
  material.needAlphaBlending = () => false;
  material.needAlphaTesting = () => false;
  material.needAlphaBlendingForMesh = (mesh) => unlitNeedsBlending(mesh);
  material.needAlphaTestingForMesh = (mesh) => { const binding = unlitBinding(mesh); return binding.cutoff > 0 && !binding.blend; };
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
  pinAttributeDefines(material, key.textured);
  const blocks: NodeMaterialBlock[] = [];
  buildSurface(material, key.textured, blocks);
  rebindPerMesh(material);
  shareCompiledProgram(material, JSON.stringify([NAME, "surface", key.textured, material.shaderLanguage]));
  // Opaque unlit meshes keep the cached stock shadow path. Registered with the build's final id (the build finishes
  // once its blocks' shader code has loaded), after the bind observers it snapshots.
  material.onBuildObservable.addOnce(() => registerCacheableShadowMaterial(material));
  material.build();
  const variants = new Map<AuthoredSurfaceVariant, { material: NodeMaterial; references: number }>();
  const registration = registerAuthoredVariants(material, (kind): AuthoredMaterialVariant => {
    let variant = variants.get(kind);
    if (!variant) variants.set(kind, (variant = { material: createVariant(material, key.textured, kind), references: 0 }));
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

/** Whether `mesh` has an unlit binding (`setUnlitMaterial`). */
export function isUnlitMesh(mesh: AbstractMesh): boolean {
  return hasUnlitBinding(mesh) && isUnlitMaterial(mesh.material);
}

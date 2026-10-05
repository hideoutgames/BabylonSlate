import {
  Constants, InputBlock, Material, NodeMaterial, NodeMaterialBlockConnectionPointTypes, PBRBaseMaterial,
  ShaderLanguage, ShadowDepthWrapper, ShadowGenerator, StandardMaterial, Texture, TextureBlock,
  type DrawWrapper, type NodeMaterialBlock, type SubMesh,
} from "@babylonjs/core";
import { AuthoredShadowDepthWrapper } from "./authored-shadow-depth-wrapper";
import { AuthoredShadowFragmentOutput, createAuthoredShadowVertexOutput } from "./authored-shadow-output";
import { registerClusteredUnlitMaterial } from "./clustered-material-policy";
import { applyLatticeDeformerPlumbing } from "./lattice-deformer-block";
import type { MaterialPlumbing } from "./material-block-registry";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";

type Generation = { material: NodeMaterial; wrapper: AuthoredShadowDepthWrapper; texture: Texture | null; uv: number; cutoff?: InputBlock };

function createGeneration(source: Material, texture: Texture | null): Generation {
  const scene = source.getScene();
  const material = new NodeMaterial(`${source.name}:latticeShadow`, scene, {
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  if (scene.getEngine().isWebGPU) rebindEmptiedDrawContexts(material);
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.alphaMode = Constants.ALPHA_DISABLE;
  material.allowShaderHotSwapping = false;
  registerClusteredUnlitMaterial(material);
  const blocks: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  createSurfacePlumbing(material.name, blocks, plumbing);
  applyLatticeDeformerPlumbing(material.name, blocks, plumbing, scene);
  const vertex = createAuthoredShadowVertexOutput(material.name, blocks, plumbing);
  const fragment = new AuthoredShadowFragmentOutput(`${material.name}_fragment`);
  blocks.push(fragment);
  let sample: TextureBlock | undefined;
  let cutoff: InputBlock | undefined;
  if (texture) {
    sample = new TextureBlock("nativeShadowOpacity");
    sample.texture = texture;
    // The stock shadow shader samples alpha independently of texture.level.
    sample.disableLevelMultiplication = true;
    if (texture.coordinatesIndex === 0) plumbing.uv!.connectTo(sample.uv);
    else if (texture.coordinatesIndex === 1) plumbing.uv2!.connectTo(sample.uv);
    else {
      const uv = new InputBlock("nativeShadowUv", undefined, NodeMaterialBlockConnectionPointTypes.Vector2);
      uv.setAsAttribute(`uv${texture.coordinatesIndex + 1}`);
      uv.output.connectTo(sample.uv); blocks.push(uv);
    }
    sample.rgba.connectTo(fragment.nativeOpacityMap);
    // Coverage must also survive the standalone base compilation. A cutoff
    // defined only by ShadowGenerator lets WebGL optimize out this sampler
    // before ShadowDepthWrapper copies the base effect's active sampler list.
    cutoff = new InputBlock("nativeShadowCutoff"); cutoff.value = 0;
    cutoff.output.connectTo(fragment.nativeAlphaCutoff);
    blocks.push(sample, cutoff);
  }
  material.onDisposeObservable.addOnce(() => {
    if (sample) sample.texture = null; // source retains the borrowed texture
    for (const block of blocks) block.dispose();
  });
  material.addOutputNode(vertex); material.addOutputNode(fragment);
  try { material.build(); }
  catch (error) { material.dispose(false, false); throw error; }
  return { material, wrapper: new AuthoredShadowDepthWrapper(material), texture, uv: texture?.coordinatesIndex ?? 0, cutoff };
}

/** Babylon's wrapper remains responsible for light/filter permutations, bias,
 * projection and encoding. A tiny standalone graph supplies final geometry.
 * The facade selects native alpha/opacity coverage before the generator binds
 * baseMaterial, avoiding the stock wrapper's GLSL-only fragment injection. */
class NativeLatticeShadowDepthWrapper extends ShadowDepthWrapper {
  private readonly source: Material;
  private readonly generations = new Map<number, Generation>();
  private readonly retirements = new Set<Promise<void>>();
  private selected?: Generation;
  private released?: Promise<void>;
  constructor(source: Material) {
    super(source, source.getScene(), { standalone: true, doNotInjectCode: true });
    this.source = source;
  }
  override get baseMaterial(): Material { return this.selected?.material ?? this.source; }
  private generation(subMesh: SubMesh, generator: ShadowGenerator): Generation {
    const mesh = subMesh.getMesh();
    const textured = this.source.needAlphaTestingForMesh(mesh) || this.source.needAlphaBlendingForMesh(mesh);
    const candidate = !textured ? null : generator.useOpacityTextureForTransparentShadow
      ? (this.source as StandardMaterial).opacityTexture : this.source.getAlphaTestTexture();
    const texture = candidate instanceof Texture ? candidate : null;
    // At most opaque, albedo-alpha and opacity generations remain resident.
    const slot = !texture ? 0 : generator.useOpacityTextureForTransparentShadow ? 2 : 1;
    let generation = this.generations.get(slot);
    if (!generation || generation.texture !== texture || generation.uv !== (texture?.coordinatesIndex ?? 0)) {
      const replacement = createGeneration(this.source, texture);
      if (generation) this.retire(generation);
      generation = replacement; this.generations.set(slot, generation);
    }
    generation.material.backFaceCulling = this.source.backFaceCulling;
    generation.material.cullBackFaces = this.source.cullBackFaces;
    if (generation.cutoff) generation.cutoff.value = this.source.needAlphaTestingForMesh(mesh)
      ? (this.source as StandardMaterial).alphaCutOff ?? ShadowGenerator.DEFAULT_ALPHA_CUTOFF : 0;
    this.selected = generation;
    return generation;
  }
  override isReadyForSubMesh(subMesh: SubMesh, defines: string[], generator: ShadowGenerator, instances: boolean, passId: number): boolean {
    if (this.released) return false;
    const generation = this.generation(subMesh, generator);
    // The native generator delegates before preparing its alpha defines when
    // a wrapper exists. Retain exactly that native cutoff/texture contract.
    const coverage = [...defines];
    if (generation.texture) {
      if (!generation.texture.isReady()) return false;
      if (generation.texture.getAlphaFromRGB) coverage.push("#define SLATE_NATIVE_OPACITY_RGB");
    }
    return generation.wrapper.isReadyForSubMesh(subMesh, coverage, generator, instances, passId);
  }
  override getEffect(subMesh: SubMesh | null, generator: ShadowGenerator, passId: number): DrawWrapper | null {
    if (!subMesh || this.released) return null;
    return this.generation(subMesh, generator).wrapper.getEffect(subMesh, generator, passId);
  }
  private retire(generation: Generation): void {
    const release = generation.wrapper.whenReleased().then(() => generation.material.dispose(false, false));
    this.retirements.add(release);
    void release.then(() => this.retirements.delete(release));
  }
  override dispose(): void {
    if (this.released) return;
    super.dispose();
    for (const generation of this.generations.values()) this.retire(generation);
    this.generations.clear(); this.selected = undefined;
    this.released = Promise.all([...this.retirements]).then(() => {});
  }
  whenReleased(): Promise<void> { this.dispose(); return this.released!; }
}

const retained = new WeakMap<Material, { wrapper: NativeLatticeShadowDepthWrapper; references: number; detach: () => void }>();

/** Acquire once per cage owner, with shared materials deduplicated by the owner. */
export function ensureNativeLatticeShadowDepthWrapper(source: Material): boolean {
  const existing = retained.get(source);
  if (existing) { existing.references++; return true; }
  if (!(source instanceof StandardMaterial || source instanceof PBRBaseMaterial)) return false;
  if (source.shadowDepthWrapper) throw new Error(`Lattice shadows cannot replace a custom shadow wrapper on "${source.name}".`);
  const wrapper = new NativeLatticeShadowDepthWrapper(source);
  const observer = source.onDisposeObservable.addOnce(() => release(source, true));
  retained.set(source, { wrapper, references: 1, detach: () => source.onDisposeObservable.remove(observer) });
  source.shadowDepthWrapper = wrapper;
  return true;
}

function release(source: Material, force: boolean): Promise<void> {
  const lease = retained.get(source);
  if (!lease || (!force && --lease.references > 0)) return Promise.resolve();
  retained.delete(source); lease.detach();
  if (source.shadowDepthWrapper === lease.wrapper) source.shadowDepthWrapper = null;
  return lease.wrapper.whenReleased();
}

/** Final release restores the source's ordinary native/cacheable shadow path. */
export function releaseNativeLatticeShadowDepthWrapper(source: Material): Promise<void> { return release(source, false); }

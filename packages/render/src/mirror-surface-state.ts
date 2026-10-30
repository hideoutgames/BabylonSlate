import { Constants, Matrix, RawTexture, Vector3, type AbstractMesh, type Material, type Scene, type ThinTexture } from "@babylonjs/core";

/** What a Mirror surface's material samples: written by the scene's mirror owner, read by Mirror Reflection blocks. */
export interface MirrorReflectionBinding {
  /** The reflection this surface last drew; null before its first draw or while it holds no storage. */
  texture: ThinTexture | null;
  /**
   * Mirror view × oblique projection of the last draw, taking positions relative to `origin` (the view's eye under
   * floating origin, otherwise the world origin): a surface point projects to clip c and reads uv = 0.5 + 0.5·c.xy/c.w.
   */
  readonly viewProjection: Matrix;
  readonly origin: Vector3;
  /** True when `texture` holds display-encoded colour; false for Scene Linear colour. */
  gammaSpace: boolean;
  /** The component's Tint, applied by the built-in surface only. */
  tint: [number, number, number];
}

const bindings = new WeakMap<AbstractMesh, MirrorReflectionBinding>();
const fallbacks = new WeakMap<Scene, RawTexture>();

/**
 * One white texel, which a Mirror Reflection block binds while its surface's reflection has not drawn (a WebGPU bind
 * group needs a texture in every binding; the block then reads none of it). Made with the scene's first Mirror
 * surface, outside any pass, and disposed with the scene.
 */
export function mirrorFallbackTexture(scene: Scene): RawTexture {
  let texture = fallbacks.get(scene);
  if (texture) return texture;
  texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  texture.name = "mirror-fallback";
  fallbacks.set(scene, texture);
  texture.onDisposeObservable.addOnce(() => fallbacks.delete(scene));
  return texture;
}

/** The scene's fallback texel if a Mirror surface made it; never allocates (a draw may ask). */
export function existingMirrorFallbackTexture(scene: Scene): RawTexture | undefined {
  return fallbacks.get(scene);
}

export function createMirrorReflectionBinding(mesh: AbstractMesh, tint: [number, number, number]): MirrorReflectionBinding {
  const binding: MirrorReflectionBinding = { texture: null, viewProjection: Matrix.Identity(), origin: Vector3.Zero(), gammaSpace: true, tint };
  bindings.set(mesh, binding);
  return binding;
}

export function mirrorReflectionBinding(mesh: AbstractMesh | null | undefined): MirrorReflectionBinding | undefined {
  return mesh ? bindings.get(mesh) : undefined;
}

const builtInMirrorMaterials = new WeakSet<Material>();

/** Marks a scene's built-in mirror surface material (`builtInMirrorMaterial`). */
export function markBuiltInMirrorMaterial(material: Material): void {
  builtInMirrorMaterials.add(material);
}

/** The engine's own mirror surface material: opaque and unlit, so its coverage is its geometry's. */
export function isBuiltInMirrorMaterial(material: Material): boolean {
  return builtInMirrorMaterials.has(material);
}

/** A Mirror component's surface: Mirror Reflection reads its reflection here and outputs black on any other mesh. */
export function isMirrorSurfaceMesh(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && bindings.has(mesh);
}

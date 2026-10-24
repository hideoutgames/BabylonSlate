import { Matrix, Vector3, type AbstractMesh, type ThinTexture } from "@babylonjs/core";

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

export function createMirrorReflectionBinding(mesh: AbstractMesh, tint: [number, number, number]): MirrorReflectionBinding {
  const binding: MirrorReflectionBinding = { texture: null, viewProjection: Matrix.Identity(), origin: Vector3.Zero(), gammaSpace: true, tint };
  bindings.set(mesh, binding);
  return binding;
}

export function mirrorReflectionBinding(mesh: AbstractMesh | null | undefined): MirrorReflectionBinding | undefined {
  return mesh ? bindings.get(mesh) : undefined;
}

/** A Mirror component's surface: Mirror Reflection reads its reflection here and outputs black on any other mesh. */
export function isMirrorSurfaceMesh(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && bindings.has(mesh);
}

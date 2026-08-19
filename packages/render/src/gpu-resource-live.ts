/**
 * Babylon 9 Texture / NodeMaterial have no `isDisposed()` (that API is on
 * Node / Mesh). Preview remount and WebGL restore still leave JS wrappers
 * around dead GPU objects, so ResourceCache and MaterialLibrary need these
 * probes instead of calling a missing method.
 */

export interface TextureDisposeProbe {
  isDisposed?: unknown;
  uniqueId?: number;
  getScene?: () => { isDisposed?: boolean } | null;
  _engine?: unknown;
}

export interface MaterialDisposeProbe {
  isDisposed?: unknown;
}

/**
 * Scene-owned textures get a `uniqueId` and `dispose()` nulls `getScene()`.
 * Engine-owned ResourceCache textures never have a scene; `dispose()` nulls
 * `_engine` after releasing the InternalTexture.
 */
export function isDisposedGpuTexture(texture: object): boolean {
  const probe = texture as TextureDisposeProbe;
  if (typeof probe.isDisposed === "function") {
    return probe.isDisposed();
  }
  if (probe.uniqueId !== undefined) {
    const scene = probe.getScene?.();
    return scene == null || scene.isDisposed === true;
  }
  return probe._engine == null;
}

/** `dispose()` removes the material from `scene.materials`. */
export function isDisposedNodeMaterial(
  material: object,
  scene: { materials: readonly unknown[] },
): boolean {
  const probe = material as MaterialDisposeProbe;
  if (typeof probe.isDisposed === "function") {
    return probe.isDisposed();
  }
  return !scene.materials.includes(material);
}

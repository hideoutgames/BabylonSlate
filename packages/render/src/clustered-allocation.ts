import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { Light, type AbstractMesh, type Scene } from "@babylonjs/core";

/** Synchronous constructor/growth boundary; cleanup releases only new owned resources. */
export function beginClusteredAllocation(
  scene: Scene,
): (failure: unknown) => never {
  const engine = scene.getEngine();
  const lights = new Set(scene.lights);
  const materials = new Set(scene.materials);
  const textures = new Set(scene.textures);
  const internals = new Set(engine.getLoadedTexturesCache());
  const wrappers = new Set(engine._renderTargetWrapperCache);
  return (failure) => {
    const errors: unknown[] = [failure];
    const attempt = (dispose: () => void) => {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const light of scene.lights.slice()) {
      if (lights.has(light) || !(light instanceof ClusteredLightContainer))
        continue;
      // Pinned constructor boundary: the proxy has left scene.meshes before its
      // first RTT allocation. The ordinary subclass dispose assumes both target
      // fields exist; a thrown constructor has not necessarily assigned them.
      const proxy = (light as Light & { _proxyMesh?: AbstractMesh })._proxyMesh;
      if (proxy) attempt(() => proxy.dispose(false, true));
      attempt(() => Light.prototype.dispose.call(light));
    }
    for (const material of scene.materials.slice())
      if (!materials.has(material)) attempt(() => material.dispose());
    for (const texture of scene.textures.slice())
      if (!textures.has(texture)) attempt(() => texture.dispose());
    // A throwing Engine allocator can create a wrapper before returning it to
    // the RTT. Re-read each cache after public disposal to avoid double release.
    for (const wrapper of engine._renderTargetWrapperCache.slice())
      if (!wrappers.has(wrapper)) attempt(() => wrapper.dispose());
    for (const texture of engine.getLoadedTexturesCache().slice())
      if (
        !internals.has(texture) &&
        !engine._renderTargetWrapperCache.some(
          (wrapper) =>
            wrapper.textures?.includes(texture) ||
            wrapper.depthStencilTexture === texture,
        )
      )
        attempt(() => texture.dispose());
    if (errors.length > 1)
      throw new AggregateError(errors, "Clustered allocation cleanup failed.");
    throw failure;
  };
}

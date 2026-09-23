import type { Effect, NodeMaterial } from "@babylonjs/core";

/**
 * Babylon 9.20 NodeMaterial skips its bindable blocks (Light UBOs) for a frozen
 * material whenever the scene cache still holds the same material and effect.
 * WebGPU draw contexts are per submesh and are emptied by DrawWrapper.setEffect,
 * so later submeshes sharing a frozen material would draw without their buffers.
 * A light UBO can also rotate its backing buffer after a camera/light update;
 * an existing binding then points at the previous generation. Refresh only a
 * missing or stale binding, without dirtying materials or rebuilding effects.
 */
export function rebindEmptiedDrawContexts(material: NodeMaterial): void {
  const original = material.bindForSubMesh.bind(material);
  material.bindForSubMesh = (world, mesh, subMesh) => {
    const wrapper = subMesh._drawWrapper;
    const effect = wrapper.effect as
      | (Effect & { _uniformBuffersNames: Record<string, number> })
      | null;
    const buffers = (
      wrapper.drawContext as { buffers?: Record<string, unknown> } | undefined
    )?.buffers;
    if (
      effect &&
      buffers &&
      material.isFrozen &&
      (Object.keys(effect._uniformBuffersNames).some(
        (name) => !(name in buffers),
      ) || mesh.lightSources.some((light, index) => {
        const name = `Light${index}`;
        return index < material.maxSimultaneousLights &&
          name in effect._uniformBuffersNames &&
          buffers[name] !== light._uniformBuffer.getBuffer();
      }))
    )
      wrapper._forceRebindOnNextCall = true;
    original(world, mesh, subMesh);
  };
}

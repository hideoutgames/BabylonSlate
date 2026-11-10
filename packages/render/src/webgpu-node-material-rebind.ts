import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { Effect } from "@babylonjs/core/Materials/effect";

// The wrapper runs for every frozen submesh draw; do not allocate names there.
const LIGHT_BUFFER_NAMES: string[] = [];
const lightBufferName = (index: number): string =>
  (LIGHT_BUFFER_NAMES[index] ??= `Light${index}`);

/**
 * Babylon 9.29 NodeMaterial skips its bindable blocks (Light UBOs) for a frozen
 * material whenever the scene cache still holds the same material and effect.
 * WebGPU draw contexts are per submesh and are emptied by DrawWrapper.setEffect,
 * so later submeshes sharing a frozen material would draw without their buffers.
 * A light UBO can also rotate its backing buffer after a camera/light update;
 * an existing binding then points at the previous generation. Refresh only a
 * missing or stale binding, without dirtying materials or rebuilding effects.
 */
export function rebindEmptiedDrawContexts(material: NodeMaterial): void {
  // The bind the material's class has when a draw asks, not the one it had here: a later patch of the class (the
  // per-mesh environment a Reflection Probe installs when it first publishes) must reach this material too.
  const own = Object.prototype.hasOwnProperty.call(material, "bindForSubMesh") ? material.bindForSubMesh : null;
  const original: NodeMaterial["bindForSubMesh"] = (world, mesh, subMesh) =>
    (own ?? (Object.getPrototypeOf(material) as NodeMaterial).bindForSubMesh).call(material, world, mesh, subMesh);
  material.bindForSubMesh = (world, mesh, subMesh) => {
    const wrapper = subMesh._drawWrapper;
    const effect = wrapper.effect as
      | (Effect & { _uniformBuffersNames: Record<string, number> })
      | null;
    const buffers = (
      wrapper.drawContext as { buffers?: Record<string, unknown> } | undefined
    )?.buffers;
    if (effect && buffers && material.isFrozen) {
      for (const name in effect._uniformBuffersNames) {
        if (name in buffers) continue;
        wrapper._forceRebindOnNextCall = true;
        break;
      }
      // Match Babylon's BindLights prefix; unbound scene lights add no work.
      const count = Math.min(mesh.lightSources.length, material.maxSimultaneousLights);
      for (let index = 0; !wrapper._forceRebindOnNextCall && index < count; index++) {
        const name = lightBufferName(index);
        if (name in effect._uniformBuffersNames &&
          buffers[name] !== mesh.lightSources[index]!._uniformBuffer.getBuffer())
          wrapper._forceRebindOnNextCall = true;
      }
    }
    original(world, mesh, subMesh);
  };
}

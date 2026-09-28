import {
  NodeMaterial,
  type Light,
  type MaterialDefines,
  type Scene,
  type ShadowLight,
} from "@babylonjs/core";
import { hasClusteredLightPolicy } from "./clustered-light-policy";

export type ShadowReceiverHandoff = {
  from: Light;
  to: Light;
  generator: object;
};
type Journal = { handoffs: ShadowReceiverHandoff[]; invalid: boolean };

// A scene that never syncs its lighting must not retain lights indefinitely.
const MAX_PENDING_HANDOFFS = 64;
const journals = new WeakMap<Scene, Journal>();

/** Every per-light input of Babylon 9.20 PrepareDefinesForLight except the generator. */
function receiverSignature(light: ShadowLight): string {
  const defines: Record<string, unknown> = {};
  light.prepareLightSpecificDefines(defines as unknown as MaterialDefines, 0);
  return JSON.stringify([
    light.getClassName(),
    Object.entries(defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    light.falloffType,
    light.specular.equalsFloats(0, 0, 0),
    light.lightmapMode,
    light.shadowEnabled,
    light.needCube(),
  ]);
}

/** Node blocks bound to one light prepare its defines outside lightSources order. */
function hasPinnedLightBlock(scene: Scene, lights: readonly Light[]): boolean {
  for (const material of scene.materials) {
    if (!(material instanceof NodeMaterial)) continue;
    for (const block of material.attachedBlocks) {
      const light = (block as { light?: unknown }).light;
      if (light && lights.includes(light as Light)) return true;
    }
  }
  return false;
}

function journal(scene: Scene): Journal {
  let current = journals.get(scene);
  if (!current) {
    current = { handoffs: [], invalid: false };
    journals.set(scene, current);
  }
  return current;
}

/** A receiver define or shadow-layout change the handoffs cannot explain. */
export function invalidateShadowReceiverHandoffs(scene: Scene): void {
  const current = journal(scene);
  current.invalid = true;
  current.handoffs.length = 0;
}

/**
 * When a shadow map moves from one light to another of the same kind, exchange
 * their positions in scene.lights and every receiver's lightSources. Each
 * shader light index keeps identical defines, so no material is dirtied and no
 * effect changes; binding follows the new order. Later lightSources rebuilds
 * reproduce the exchange from scene.lights. Returns false without changing
 * anything, and invalidates pending handoffs, when any receiver would change.
 */
export function exchangeShadowReceivers(
  scene: Scene,
  from: ShadowLight,
  to: ShadowLight,
  generator: object,
): boolean {
  const lights = scene.lights;
  const a = lights.indexOf(from);
  const b = lights.indexOf(to);
  const exchange = new Set<Light[]>();
  const valid =
    a >= 0 &&
    b >= 0 &&
    // Clustered Forward re-sorts lightSources and moves lights into the cluster.
    !hasClusteredLightPolicy(scene) &&
    receiverSignature(from) === receiverSignature(to) &&
    !hasPinnedLightBlock(scene, [from, to]) &&
    scene.meshes.every((mesh) => {
      // InstancedMesh shares its source's array; exchange each array once.
      const sources = mesh.lightSources;
      const i = sources.indexOf(from);
      const j = sources.indexOf(to);
      if (i < 0 !== j < 0) return false;
      if (i >= 0) exchange.add(sources);
      return true;
    });
  // Without a receiver holding both lights there is no define to preserve.
  if (!valid || !exchange.size) {
    invalidateShadowReceiverHandoffs(scene);
    return false;
  }
  lights[a] = to;
  lights[b] = from;
  for (const sources of exchange) {
    const i = sources.indexOf(from);
    const j = sources.indexOf(to);
    sources[i] = to;
    sources[j] = from;
  }
  const current = journal(scene);
  if (!current.invalid) {
    if (current.handoffs.length < MAX_PENDING_HANDOFFS)
      current.handoffs.push({ from, to, generator });
    else invalidateShadowReceiverHandoffs(scene);
  }
  return true;
}

/** Handoffs since the previous call; undefined when none were recorded. */
export function takeShadowReceiverHandoffs(
  scene: Scene,
): Readonly<Journal> | undefined {
  const current = journals.get(scene);
  journals.delete(scene);
  return current;
}

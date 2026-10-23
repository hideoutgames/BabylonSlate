import {
  InstancedMesh,
  type AbstractMesh,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { pinnedLights, receiverSignature } from "./shadow-receiver-handoff";

/** One Forward admission change: `to` took `from`'s shader light index on every receiver. */
export type ForwardLightSlotExchange = {
  from: Light;
  to: Light;
  /** Every receiver kept identical light defines, so no receiver was dirtied. */
  preserved: boolean;
};

export const NO_FORWARD_LIGHT_SLOT_EXCHANGES: readonly ForwardLightSlotExchange[] =
  Object.freeze([]);

/**
 * The defines a light gives its shader slot on every receiver, or null when
 * they cannot be shared: a shadow map's defines belong to its generator, and
 * an unready light texture keeps materials from reusing a ready effect.
 */
function slotSignature(scene: Scene, light: Light): string | null {
  if (light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator())
    return null;
  if (!light.areLightTexturesReady()) return null;
  return receiverSignature(light);
}

/**
 * Babylon disables a light by splicing it out of each `mesh.lightSources` and
 * enables one by appending it, so one Forward swap would move every later
 * light down a shader index and give each lit material new defines. Call this
 * before the toggles with the lights the budget drops and admits: each
 * admitted light takes the index of a dropped one (same slot signature first)
 * in `scene.lights` and in every receiver that both can light, so Babylon's
 * own resyncs find nothing to change there and later `lightSources` rebuilds
 * reproduce the order. An exchange is preserved, dirtying nothing, only when
 * both lights have the same slot signature and every mesh holds both or
 * neither; otherwise the exchanged receivers are dirtied (Babylon dirties the
 * meshes that hold only one). Admitted lights without a partner move to the
 * end of `scene.lights`, matching where Babylon appends them. The caller keeps
 * sun and fill lights out (sun ownership follows scene order) and skips
 * Clustered Forward, which orders lights itself.
 */
export function exchangeForwardLightSlots(
  scene: Scene,
  leaving: readonly Light[],
  entering: readonly Light[],
): ForwardLightSlotExchange[] {
  const signatures = new Map<Light, string | null>();
  const signature = (light: Light) => {
    if (!signatures.has(light)) signatures.set(light, slotSignature(scene, light));
    return signatures.get(light)!;
  };
  const partners = leaving.slice();
  const pairs: Array<[Light, Light]> = [];
  const unmatched: Light[] = [];
  for (const to of entering) {
    const key = partners.length ? signature(to) : null;
    const index = key === null ? -1 : partners.findIndex((from) => signature(from) === key);
    if (index < 0) unmatched.push(to);
    else pairs.push([partners.splice(index, 1)[0]!, to]);
  }
  const appended: Light[] = [];
  for (const to of unmatched) {
    const from = partners.shift();
    if (from) pairs.push([from, to]);
    else appended.push(to);
  }
  const lights = scene.lights;
  const exchanges: ForwardLightSlotExchange[] = [];
  const pinned = pairs.length ? pinnedLights(scene) : undefined;
  const receivers: AbstractMesh[] = [];
  for (const [from, to] of pairs) {
    const a = lights.indexOf(from);
    const b = lights.indexOf(to);
    if (a < 0 || b < 0) continue;
    lights[a] = to;
    lights[b] = from;
    let preserved =
      signature(from) !== null &&
      signature(from) === signature(to) &&
      !pinned!.has(from) &&
      !pinned!.has(to);
    receivers.length = 0;
    for (const mesh of scene.meshes) {
      // An instance shares its source's array, which the source updates.
      if (mesh instanceof InstancedMesh) continue;
      const sources = mesh.lightSources;
      const lit = sources.includes(from);
      const reaches = !sources.includes(to) && to.canAffectMesh(mesh);
      if (lit && reaches) receivers.push(mesh);
      // Babylon splices `from` out of, or appends `to` to, this mesh's
      // lights, so its later slots change: refresh every receiver's shader.
      else if (lit || reaches) preserved = false;
    }
    for (const mesh of receivers) {
      const sources = mesh.lightSources;
      sources[sources.indexOf(from)] = to;
      // As Babylon's removal does: never draw the old effect with the new light.
      if (!preserved) mesh._markSubMeshesAsLightDirty(true);
    }
    exchanges.push({ from, to, preserved });
  }
  receivers.length = 0;
  if (appended.length) {
    // After every light that is lit once the toggles land.
    const incoming = new Set(exchanges.map(({ to }) => to));
    let tail = 0;
    for (let index = 0; index < lights.length; index++)
      if (lights[index]!.isEnabled() || incoming.has(lights[index]!)) tail = index + 1;
    for (const light of appended) {
      const index = lights.indexOf(light);
      if (index < 0) continue;
      lights.splice(index, 1);
      if (index < tail) tail--;
      lights.splice(tail++, 0, light);
    }
  }
  return exchanges;
}

/**
 * A light's place in the canonical order: whether it binds a shadow map, then
 * the defines it gives its slot on every receiver. Lights of one class are
 * interchangeable in the canonical arrangement's shaders; a forward-dropped
 * light keeps its standby map, so it keeps its class.
 */
export function forwardSlotClass(scene: Scene, light: Light): string {
  const shadowed = !!(light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator());
  return `${shadowed ? 1 : 0}${receiverSignature(light)}`;
}

/**
 * After the toggles of a budget transition whose receivers refresh anyway (an
 * exchange that is not preserved, an admission without a partner, a drop
 * without an admission): put the `movable` lights in a canonical order, the
 * enabled ones first by slot class and then creation, the others after them in
 * their current order, within the `scene.lights` positions movable lights
 * already hold. Every receiver whose lights are out of that order is re-sorted
 * and dirtied, so its light defines depend only on which lights reach it: a
 * light set the budget returns to rebuilds the shaders it compiled before, where
 * a chain of exchanges would otherwise leave it in another slot arrangement.
 * Same-class lights stay interchangeable, so a preserved exchange (same slot
 * signature, no shadow map) keeps a canonical arrangement's defines, and a
 * receiver whose re-sort only permutes lights with one slot signature keeps its
 * defines and is not dirtied. Returns whether any light moved.
 */
export function canonicalizeForwardLightSlots(
  scene: Scene,
  movable: (light: Light) => boolean,
): boolean {
  const lights = scene.lights;
  const positions: number[] = [];
  const enabled: Light[] = [];
  const disabled: Light[] = [];
  for (let index = 0; index < lights.length; index++) {
    const light = lights[index]!;
    if (!movable(light)) continue;
    positions.push(index);
    (light.isEnabled() ? enabled : disabled).push(light);
  }
  const classes = new Map<Light, string>();
  for (const light of enabled) classes.set(light, forwardSlotClass(scene, light));
  enabled.sort((a, b) => {
    const left = classes.get(a)!;
    const right = classes.get(b)!;
    return left < right ? -1 : left > right ? 1 : a.uniqueId - b.uniqueId;
  });
  const ordered = enabled.concat(disabled);
  let moved = false;
  for (let index = 0; index < positions.length; index++) {
    if (lights[positions[index]!] === ordered[index]) continue;
    lights[positions[index]!] = ordered[index]!;
    moved = true;
  }
  if (!moved) return false;
  sortReceiverLightSources(scene);
  return true;
}

/**
 * Puts `scene.lights` back in `order` (the same lights, as a load rehearsal recorded them before a light change it
 * tried) and re-sorts the receivers to it. Admission exchanges a light it drops with the one it admits in that order,
 * so receivers keep their defines; the exchanges a change made and its revert did not undo would leave the same
 * lights in other slots, and receivers asking for variants a load without the change never compiles. Returns whether
 * any light moved.
 */
export function restoreSceneLightOrder(scene: Scene, order: readonly Light[]): boolean {
  const lights = scene.lights;
  if (lights.length !== order.length) return false;
  const members = new Set(lights);
  if (!order.every((light) => members.has(light))) return false;
  let moved = false;
  for (let index = 0; index < order.length; index++) {
    if (lights[index] === order[index]) continue;
    lights[index] = order[index]!;
    moved = true;
  }
  if (moved) sortReceiverLightSources(scene);
  return moved;
}

/**
 * Re-sort every receiver whose `lightSources` is out of `scene.lights` order,
 * which is the order Babylon's rebuilds (`addMesh`, `addLight`, `layerMask`)
 * reproduce. A receiver whose re-sort only permutes lights with one slot
 * signature keeps its defines and is not dirtied; any other is dirtied. Returns
 * whether any receiver was dirtied.
 */
export function sortReceiverLightSources(scene: Scene): boolean {
  const lights = scene.lights;
  const rank = new Map<Light, number>();
  for (let index = 0; index < lights.length; index++) rank.set(lights[index]!, index);
  const place = (light: Light) => rank.get(light) ?? Number.MAX_SAFE_INTEGER;
  const signatures = new Map<Light, string | null>();
  const signature = (light: Light) => {
    if (!signatures.has(light)) signatures.set(light, slotSignature(scene, light));
    return signatures.get(light)!;
  };
  const before: Light[] = [];
  let dirtied = false;
  for (const mesh of scene.meshes) {
    // An instance shares its source's array, which the source re-sorts.
    if (mesh instanceof InstancedMesh) continue;
    const sources = mesh.lightSources;
    let sorted = true;
    for (let index = 1; sorted && index < sources.length; index++)
      sorted = place(sources[index - 1]!) <= place(sources[index]!);
    if (sorted) continue;
    before.length = 0;
    before.push(...sources);
    sources.sort((a, b) => place(a) - place(b));
    let neutral = true;
    for (let index = 0; neutral && index < sources.length; index++) {
      const light = sources[index]!;
      const previous = before[index]!;
      neutral = light === previous || (signature(light) !== null && signature(light) === signature(previous));
    }
    if (neutral) continue;
    // As Babylon's removal does: never draw the old effect with lights in new slots.
    mesh._markSubMeshesAsLightDirty(true);
    dirtied = true;
  }
  before.length = 0;
  return dirtied;
}

/**
 * After the toggles: an exchange whose lights did not reach the predicted
 * state (a parent changed in the same pass) is undone in `scene.lights` and
 * handed back to Babylon's resync, which repairs membership and dirties the
 * receivers.
 */
export function settleForwardLightSlots(
  scene: Scene,
  exchanges: readonly ForwardLightSlotExchange[],
): void {
  for (const exchange of exchanges) {
    const { from, to } = exchange;
    if (!from.isEnabled() && to.isEnabled()) continue;
    exchange.preserved = false;
    const lights = scene.lights;
    const a = lights.indexOf(to);
    const b = lights.indexOf(from);
    if (a >= 0 && b >= 0) {
      lights[a] = from;
      lights[b] = to;
    }
    for (const mesh of scene.meshes) {
      mesh._resyncLightSource(from);
      mesh._resyncLightSource(to);
    }
  }
}

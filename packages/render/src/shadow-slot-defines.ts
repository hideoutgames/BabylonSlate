import type { MaterialDefines } from "@babylonjs/core";

/**
 * The receiver defines the controller adds per light slot beside Babylon's
 * SHADOW{n} family: `SLATE_SHADOW_AUTO{n}` (receiver-plane correction) and
 * `SLATE_SHADOW_FADE{n}` (cascade distance fade). Their shader code is guarded
 * by the slot's own light and shadow defines.
 */
const SLOT_DEFINES = ["SLATE_SHADOW_AUTO", "SLATE_SHADOW_FADE"] as const;

const slotsByDefines = new WeakMap<object, Set<number>>();

/**
 * Babylon resets its own per-slot defines whenever a slot's light changes, but
 * not these. Left set after a cascaded sun leaves slot n (a fill takes it, or
 * the light count shrinks past it), they add no shader code yet differ in the
 * defines text, which keys the Effect cache, so an identical program links
 * again. Their text is therefore cleared once no shadow map is bound to the slot.
 * The slot is cleared when the text is built, which follows every light pass of
 * every material kind, however the slot lost its light.
 *
 * Call from the generator's `prepareDefines`: a defines object can only hold
 * these values after that hook has run on it, so only those objects are wrapped.
 */
export function trackShadowSlotDefines(defines: MaterialDefines, lightIndex: number): void {
  let slots = slotsByDefines.get(defines);
  if (!slots) {
    const tracked = (slots = new Set<number>());
    slotsByDefines.set(defines, slots);
    const text = defines.toString;
    // Not enumerable: MaterialDefines.rebuild() lists enumerable keys as defines.
    Object.defineProperty(defines, "toString", {
      configurable: true,
      writable: true,
      value(this: MaterialDefines & Record<string, unknown>) {
        for (const slot of tracked) {
          if (this[`SHADOW${slot}`]) continue;
          for (const name of SLOT_DEFINES)
            if (this[`${name}${slot}`] !== undefined) this[`${name}${slot}`] = false;
        }
        return text.call(this);
      },
    });
  }
  slots.add(lightIndex);
}

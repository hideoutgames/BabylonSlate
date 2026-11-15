import { animStateEventNames, type AnimGraphDimension, type AnimGraphDocument } from "@haptic/anim-graph";
import { normalizeAnimationPayload, parseSpriteAnimationPayload } from "@haptic/assets";
import { animGraphPlaysAsset } from "./anim-pose-inspector";

/** An Animation Event name the graph can fire; `window` when it has a begin and an end. */
export type AnimGraphEventEntry = { name: string; window: boolean };

/** The title of the Animation Object's node for one Animation Event. */
export function animEventNodeTitle(name: string): string {
  return `Event ${name}`;
}

/**
 * The Animation Events an Animation Graph can fire, by name: those on the clips it can play (a 3D graph's Animations
 * on its Skeleton, a 2D graph's Sprite Animations) and its states' own events. A name that is a window on any clip is
 * a window.
 */
export function animGraphEventEntries(
  doc: AnimGraphDocument,
  dimension: AnimGraphDimension,
  assets: ReadonlyArray<{ header: { type: string; payload?: unknown } }>,
): AnimGraphEventEntry[] {
  const byName = new Map<string, boolean>();
  const add = (name: string, window: boolean) => {
    if (name) byName.set(name, (byName.get(name) ?? false) || window);
  };
  const graph = { dimension, skeletonGuid: doc.skeletonGuid };
  for (const asset of assets) {
    if (!animGraphPlaysAsset(asset.header, graph)) continue;
    if (asset.header.type === "Animation") {
      for (const event of normalizeAnimationPayload(asset.header.payload ?? {}).events ?? []) add(event.name, event.durationMs > 0);
    } else if (asset.header.type === "SpriteAnimation") {
      for (const frame of parseSpriteAnimationPayload(asset.header.payload ?? {}).frames) {
        for (const event of frame.events ?? []) add(event.name, false);
      }
    }
  }
  for (const state of doc.stateMachine.states) for (const name of animStateEventNames(state.events)) add(name, false);
  return [...byName].map(([name, window]) => ({ name, window })).sort((a, b) => a.name.localeCompare(b.name));
}

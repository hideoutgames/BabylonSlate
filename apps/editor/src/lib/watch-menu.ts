import { humanizePropertyLabel, type NestedMenuItem } from "@haptic/editor-kit";
import { hasSerializedPins } from "@haptic/graph-ui";
import type { PinWatch, WatchStore } from "../services/watch-store";

/** A pin the graph debugger records a value for. */
export type WatchablePin = { id: string; direction: "in" | "out"; name: string };

/**
 * The pins of a Class graph node whose value the followed object reports: every data output, and the
 * data inputs a node that runs reads through a wire. A pure node reports only its outputs, and an
 * unwired input only shows its literal on the node.
 */
export function watchablePins(data: Record<string, unknown> | undefined, isWired: (pinId: string) => boolean): WatchablePin[] {
  if (!hasSerializedPins(data)) return [];
  const pure = data.__pure === true;
  return data.__pins
    .filter((pin) => pin.kind === "data" && (pin.direction === "out" || (!pure && isWired(pin.id))))
    .map((pin) => ({ id: pin.id, direction: pin.direction, name: humanizePropertyLabel(pin.name) }));
}

/**
 * A node menu's **Watch Pin** submenu: each watchable pin, inputs first, checked while watched. Empty when the
 * node has none.
 */
export function watchPinMenuItems(
  store: WatchStore,
  pins: readonly WatchablePin[],
  watch: (pin: WatchablePin) => PinWatch,
): NestedMenuItem[] {
  if (pins.length === 0) return [];
  const item = (pin: WatchablePin): NestedMenuItem => {
    const entry = watch(pin);
    return {
      type: "checkbox",
      id: `watch-${pin.direction}-${pin.id}`,
      label: pin.name,
      checked: store.has(entry),
      onCheckedChange: (next) => (next ? store.add(entry) : store.remove(entry)),
    };
  };
  const inputs = pins.filter((pin) => pin.direction === "in").map(item);
  const outputs = pins.filter((pin) => pin.direction === "out").map(item);
  return [{
    type: "submenu",
    id: "watch-pin",
    label: "Watch Pin",
    items: inputs.length > 0 && outputs.length > 0
      ? [...inputs, { type: "separator", id: "watch-pin-outputs" }, ...outputs]
      : [...inputs, ...outputs],
  }];
}

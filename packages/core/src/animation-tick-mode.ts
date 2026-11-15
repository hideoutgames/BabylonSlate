/**
 * When an Animation Graph component runs (`tickMode`): Always (the default) evaluates and poses every frame; When
 * Visible evaluates every frame but poses the actor only while a camera can see it (or its shadow); Never stops the
 * graph, which holds its pose and fires no events.
 */
export const ANIMATION_TICK_MODES = ["always", "whenVisible", "never"] as const;
export type AnimationTickMode = (typeof ANIMATION_TICK_MODES)[number];
export const ANIMATION_TICK_MODE_LABELS: Record<AnimationTickMode, string> = {
  always: "Always",
  whenVisible: "When Visible",
  never: "Never",
};
/** The Animation Graph component property (and component variable at runtime) holding the mode. */
export const ANIMATION_TICK_MODE_PROPERTY = "tickMode";
/** Get and Set Animation Tick Mode's enum; its members are the labels. */
export const ENGINE_ANIMATION_TICK_MODE_ENUM_ID = "engine:AnimationTickMode";

/** A tick mode from its id, its label (an enum value) or its member index; Always otherwise. */
export function parseAnimationTickMode(value: unknown): AnimationTickMode {
  if (typeof value === "number") return ANIMATION_TICK_MODES[value] ?? "always";
  if (typeof value !== "string") return "always";
  return ANIMATION_TICK_MODES.find((mode) => mode === value || ANIMATION_TICK_MODE_LABELS[mode] === value) ?? "always";
}

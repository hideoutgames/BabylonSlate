import {
  parseText2DAppearProperties,
  TEXT2D_APPEAR_TRANSITIONS,
  TEXT2D_APPEAR_TRANSITION_LABELS,
  TEXT2D_APPEAR_STARTS,
  TEXT2D_APPEAR_START_LABELS,
  type SerializedComponent,
} from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";

export function richTextAppearPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
): PropertyRow[] {
  const parsed = parseText2DAppearProperties(component.properties);
  const defaults = parseText2DAppearProperties({});
  const off = parsed.appearModes.length === 0;
  const instant = parsed.appearModes.includes("instant");
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  return [
    {
      kind: "enum", id: id("appearStart"), label: "Appear Start", value: parsed.appearStart,
      defaultValue: defaults.appearStart,
      options: TEXT2D_APPEAR_STARTS.map((value) => ({ value, label: TEXT2D_APPEAR_START_LABELS[value] })),
      description: "Initial state in Play. The editor keeps the full text visible for authoring.",
      onChange: (next) => update("appearStart", next),
    },
    {
      kind: "enum", id: id("appearTransition"), label: "Appear Transition", value: parsed.appearTransition,
      defaultValue: defaults.appearTransition,
      disabled: off || instant,
      options: TEXT2D_APPEAR_TRANSITIONS.map((value) => ({ value, label: TEXT2D_APPEAR_TRANSITION_LABELS[value] })),
      onChange: (next) => update("appearTransition", next),
    },
    {
      kind: "number", id: id("appearInterval"), label: "Time Between Characters", unit: "s",
      value: parsed.appearInterval, defaultValue: defaults.appearInterval, min: 0, precision: 3, sensitivity: 0.01,
      disabled: off,
      description: "0 reveals every character simultaneously. Inline images count as one character; formatting tags do not count.",
      onChange: (next) => update("appearInterval", Math.max(0, next)),
    },
    {
      kind: "number", id: id("appearDuration"), label: "Character Reveal Duration", unit: "s",
      value: parsed.appearDuration, defaultValue: defaults.appearDuration, min: 0, precision: 3, sensitivity: 0.01,
      disabled: off || instant || parsed.appearTransition === "instant",
      description: "Time for each character's transition. Instant ignores this duration.",
      onChange: (next) => update("appearDuration", Math.max(0, next)),
    },
  ];
}

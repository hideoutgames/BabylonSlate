import {
  customEasingCurveLabel,
  parseText2DAppearProperties,
  TEXT2D_APPEAR_TRANSITIONS,
  TEXT2D_APPEAR_TRANSITION_LABELS,
  TEXT2D_APPEAR_STARTS,
  TEXT2D_APPEAR_START_LABELS,
  TEXT2D_APPEAR_SOUND_PLAYS,
  TEXT2D_APPEAR_SOUND_PLAY_LABELS,
  type CustomEasingCurveRef,
  type SerializedComponent,
  type Text2DAppearTransition,
} from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { assetRow, type ComponentPropertyContext } from "./component-property-row-helpers";

/**
 * The built-in transitions, then the project's custom easing curves as `<Class> (Custom)`; a stored curve whose Class
 * is gone stays listed, so the row still shows what is stored.
 */
function appearTransitionOptions(current: Text2DAppearTransition, custom: readonly CustomEasingCurveRef[]) {
  const curves = custom.includes(current as CustomEasingCurveRef) || !customEasingCurveLabel(current) ? custom : [...custom, current as CustomEasingCurveRef];
  return [
    ...TEXT2D_APPEAR_TRANSITIONS.map((value) => ({ value: value as string, label: TEXT2D_APPEAR_TRANSITION_LABELS[value] })),
    ...curves.map((value) => ({ value: value as string, label: customEasingCurveLabel(value)! })),
  ];
}

export function richTextAppearPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
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
      // Labels are final: a custom curve shows its Class name as written.
      options: appearTransitionOptions(parsed.appearTransition, context.customEasingCurves ?? []), verbatim: true,
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
    {
      kind: "boolean", id: id("appearSound"), label: "Appear Sound", value: parsed.appearSound,
      disabled: off,
      description: "Plays while the text appears. Play Reverse is silent.",
      onChange: (next) => update("appearSound", next),
    },
    ...(parsed.appearSound ? [
      { ...assetRow(actorId, component, "appearSoundAssetGuid", "Sound", ["Audio"], update, context, "Pick Audio"), disabled: off },
      {
        kind: "enum", id: id("appearSoundPlay"), label: "Sound Play", value: parsed.appearSoundPlay,
        defaultValue: defaults.appearSoundPlay,
        disabled: off,
        options: TEXT2D_APPEAR_SOUND_PLAYS.map((value) => ({ value, label: TEXT2D_APPEAR_SOUND_PLAY_LABELS[value] })),
        description: "Letters skip spaces. Loop Until Finished stops when the last character has appeared.",
        onChange: (next) => update("appearSoundPlay", next),
      },
      {
        kind: "number", id: id("appearSoundOffset"), label: "Sound Offset", unit: "s",
        value: parsed.appearSoundOffset, defaultValue: defaults.appearSoundOffset, min: 0, precision: 3, sensitivity: 0.01,
        disabled: off,
        onChange: (next) => update("appearSoundOffset", Math.max(0, next)),
      },
    ] satisfies PropertyRow[] : []),
  ];
}

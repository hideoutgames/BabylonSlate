import { EASING_CURVES, EASING_CURVE_LABELS, type CurveInterpolation } from "@haptic/core";

/**
 * How a Timeline key moves to the next one, as menus and the Inspector name it.
 * Ease In, Ease Out and Ease In Out are the cubic easings; every easing curve
 * is also listed by its own name.
 */

export const TIMELINE_EASE_SHORTCUTS = [
  { value: "cubicIn", label: "Ease In" },
  { value: "cubicOut", label: "Ease Out" },
  { value: "cubicInOut", label: "Ease In Out" },
] as const satisfies ReadonlyArray<{ value: CurveInterpolation; label: string }>;

/** Easing curves other than Linear, which is a plain interpolation here. */
export const TIMELINE_EASING_CURVES = EASING_CURVES.filter((curve) => curve !== "linear");

export function timelineInterpolationLabel(value: CurveInterpolation): string {
  switch (value) {
    case "constant": return "Constant";
    case "linear": return "Linear";
    case "auto": return "Auto";
    case "custom": return "Custom";
    default: return TIMELINE_EASE_SHORTCUTS.find((entry) => entry.value === value)?.label ?? EASING_CURVE_LABELS[value];
  }
}

/** The Inspector's options: the plain interpolations, then every easing curve. */
export const TIMELINE_INTERPOLATION_OPTIONS: ReadonlyArray<{ value: CurveInterpolation; label: string }> = [
  { value: "constant", label: "Constant" },
  { value: "linear", label: "Linear" },
  { value: "auto", label: "Auto" },
  ...TIMELINE_EASING_CURVES.map((curve) => ({ value: curve, label: timelineInterpolationLabel(curve) })),
];

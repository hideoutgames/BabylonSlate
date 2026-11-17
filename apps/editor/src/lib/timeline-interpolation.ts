import { EASING_CURVES, EASING_CURVE_LABELS, customEasingCurveLabel, type CurveInterpolation, type CustomEasingCurveRef } from "@haptic/core";

/**
 * How a Timeline key moves to the next one, as menus and the Inspector name it.
 * Ease In, Ease Out and Ease In Out are the cubic easings; every easing curve
 * is also listed by its own name, and the project's custom easing curves as
 * `<Class> (Custom)`.
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
    default: return customEasingCurveLabel(value)
      ?? TIMELINE_EASE_SHORTCUTS.find((entry) => entry.value === value)?.label
      ?? EASING_CURVE_LABELS[value as keyof typeof EASING_CURVE_LABELS] ?? String(value);
  }
}

/** The Inspector's options: the plain interpolations, then every easing curve. */
export const TIMELINE_INTERPOLATION_OPTIONS: ReadonlyArray<{ value: CurveInterpolation; label: string }> = [
  { value: "constant", label: "Constant" },
  { value: "linear", label: "Linear" },
  { value: "auto", label: "Auto" },
  ...TIMELINE_EASING_CURVES.map((curve) => ({ value: curve, label: timelineInterpolationLabel(curve) })),
];

/**
 * `TIMELINE_INTERPOLATION_OPTIONS` and then the project's custom easing curves; `current` (a selected key's value)
 * is added when it is not listed, so a curve whose Class is gone still shows.
 */
export function timelineInterpolationOptions(
  custom: readonly CustomEasingCurveRef[],
  current?: CurveInterpolation,
): Array<{ value: CurveInterpolation; label: string }> {
  const options = [...TIMELINE_INTERPOLATION_OPTIONS, ...custom.map((value) => ({ value, label: timelineInterpolationLabel(value) }))];
  if (current !== undefined && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: timelineInterpolationLabel(current) });
  }
  return options;
}

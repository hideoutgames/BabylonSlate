/**
 * A number's unit shown after the value in its field (`45°`, `120 ms`,
 * `50%`) and accepted when typed. Units are free text such as "s", "ms",
 * "px", "%" or "m/s"; "deg" reads as the degree sign.
 */

const DEGREE_ALIASES = ["degrees", "degree", "deg", "°"] as const;

/** The suffix a field shows: degrees as `°`, everything else as given. */
export function numberUnitSuffix(unit: string): string {
  const trimmed = unit.trim();
  if ((DEGREE_ALIASES as readonly string[]).includes(trimmed.toLowerCase())) return "°";
  return trimmed.replace(/^deg\//i, "°/");
}

/** Short units sit inside the field; longer phrases ("scene units") stay by the label. */
export function isInlineNumberUnit(unit: string | undefined): unit is string {
  if (!unit) return false;
  const suffix = numberUnitSuffix(unit);
  return suffix.length > 0 && suffix.length <= 6 && !/\s/.test(suffix);
}

/** `formatted` with the unit after it, as a field shows it while idle. */
export function withNumberUnit(formatted: string, unit: string | undefined): string {
  if (!unit || formatted === "") return formatted;
  const suffix = numberUnitSuffix(unit);
  // Symbols and rates hug the number (`45°`, `20/s`); letters keep a space (`120 ms`).
  return /^[°%×/]/.test(suffix) ? `${formatted}${suffix}` : `${formatted} ${suffix}`;
}

/** Removes a trailing unit the person typed or left from the idle display. */
export function stripNumberUnit(raw: string, unit: string | undefined): string {
  const trimmed = raw.trim();
  if (!unit) return trimmed;
  const suffix = numberUnitSuffix(unit);
  const forms = [suffix, unit.trim(), ...(suffix === "°" ? DEGREE_ALIASES : [])]
    .filter((form) => form.length > 0)
    .sort((a, b) => b.length - a.length);
  const lower = trimmed.toLowerCase();
  for (const form of forms) {
    if (lower.endsWith(form.toLowerCase())) return trimmed.slice(0, trimmed.length - form.length).trim();
  }
  return trimmed;
}

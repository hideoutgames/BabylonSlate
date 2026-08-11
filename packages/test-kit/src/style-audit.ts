/**
 * Static style audits for the rules in engineplan section 2.4 that a running
 * browser cannot easily prove: radii must come from the --radius-* scale, so a
 * hardcoded value anywhere in an authored stylesheet is a defect even if the
 * element it styles never renders in a test.
 */
const RADIUS_DECLARATION = /border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/gi;

/** 0, fully-round and pill values are shape choices, not points on the scale. */
const ALLOWED_RADIUS = /^(var\(--radius[a-z0-9-]*\)|0|50%|9999px|inherit)$/;

export function findRadiusDeclarations(css: string): string[] {
  return [...css.matchAll(RADIUS_DECLARATION)].map((match) => match[1].trim());
}

/** Returns the offending radius values, so an empty array means the CSS is clean. */
export function findHardcodedRadii(css: string): string[] {
  return findRadiusDeclarations(css).filter(
    (value) => !ALLOWED_RADIUS.test(value),
  );
}

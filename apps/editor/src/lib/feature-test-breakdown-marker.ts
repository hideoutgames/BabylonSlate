/** Where the Breakdown's A/B keeps its resume marker across the editor reload (`feature-test-breakdown-ab.ts`). */
export const BREAKDOWN_RESUME_KEY = "haptic:feature-test-check:breakdown-resume";

/**
 * Whether a resume marker is stored, readable or not. Home checks this before it loads the A/B and the check's
 * runner, which a launch without a Breakdown waiting never needs.
 */
export function hasBreakdownResumeMarker(): boolean {
  try {
    return localStorage.getItem(BREAKDOWN_RESUME_KEY) !== null;
  } catch {
    // Unavailable storage holds no marker.
    return false;
  }
}

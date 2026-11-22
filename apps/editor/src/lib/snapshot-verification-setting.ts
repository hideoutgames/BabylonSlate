import { isTestModeEnabled } from "@haptic/vfs";

/** Browser storage key of the test-mode switch; `"on"` turns snapshot verification on for Play sessions started after. */
export const SNAPSHOT_VERIFICATION_KEY = "haptic:test:verifySnapshotPublishes";

/**
 * Whether Play's runtime checks every snapshot publish against a whole-World pass (`verifySnapshotPublishes` on the
 * `load` control; frames that differ come back as `stats` `snapshotMismatches`, which must stay 0). Test mode only,
 * read when a session starts: the Feature Test performance route stores it (`HAPTIC_PERF_VERIFY_SNAPSHOTS=1`).
 */
export function snapshotVerificationRequested(): boolean {
  if (!isTestModeEnabled()) return false;
  try {
    return globalThis.localStorage?.getItem(SNAPSHOT_VERIFICATION_KEY) === "on";
  } catch {
    return false;
  }
}

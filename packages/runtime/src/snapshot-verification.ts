/**
 * Whole-World checks of snapshot publishes. `SnapshotPublisher` keeps its rows, poses and slot checks current from
 * World and slot notifications; a change made without one would leave a stale row that a whole-World pass would
 * have repaired. While verification is on, every publish also recomputes what a whole-World pass publishes for that
 * frame and compares rows, actor count, origin and the slot table; a differing frame is counted
 * (`snapshotMismatches` in `stats`), which must stay 0. Nothing published changes.
 */

/** What the whole-World checks found: frames checked, frames that differed and the first differences. */
export type SnapshotPublishVerification = { checks: number; mismatches: number; samples: string[] };

/** Differences kept per record; later ones are only counted. */
export const SNAPSHOT_VERIFICATION_SAMPLES = 8;

let verifying = false;
const totals: SnapshotPublishVerification = { checks: 0, mismatches: 0, samples: [] };

/**
 * Debugging aid: publishers created from now on check every publish against a whole-World pass. Each runtime can
 * also turn it on alone (`RuntimeDriverOptions.verifySnapshotPublishes`).
 */
export function verifySnapshotPublishes(enabled: boolean): void {
  verifying = enabled;
}

export function verifyingSnapshotPublishes(): boolean {
  return verifying;
}

/** Checks by every publisher since the last reset (test teardown asserts no mismatch). */
export function snapshotPublishVerification(): Readonly<SnapshotPublishVerification> {
  return totals;
}

export function resetSnapshotPublishVerification(): void {
  totals.checks = 0;
  totals.mismatches = 0;
  totals.samples.length = 0;
}

/** Count one checked frame into `record` and the totals; `differences` empty when it matched. */
export function noteSnapshotPublishCheck(record: SnapshotPublishVerification, differences: readonly string[]): void {
  for (const target of [record, totals]) {
    target.checks += 1;
    if (differences.length === 0) continue;
    target.mismatches += 1;
    for (const difference of differences) {
      if (target.samples.length >= SNAPSHOT_VERIFICATION_SAMPLES) break;
      target.samples.push(difference);
    }
  }
}

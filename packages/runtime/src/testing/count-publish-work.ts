import { onTestFinished } from "vitest";
import { verifySnapshotPublishes, verifyingSnapshotPublishes } from "../snapshot-verification";

/**
 * For a test that counts what a publish reads or writes: publishers it creates from now on skip the whole-World
 * check (`verify-snapshot-publishes.setup.ts`), which reads every actor. The switch is restored when the test ends.
 */
export function countPublishWork(): void {
  const verifying = verifyingSnapshotPublishes();
  verifySnapshotPublishes(false);
  onTestFinished(() => verifySnapshotPublishes(verifying));
}

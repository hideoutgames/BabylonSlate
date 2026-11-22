/**
 * Vitest setup for the node project: every snapshot publisher a test creates checks each publish against a
 * whole-World pass, and a test fails when any published frame differed. A difference means some World change
 * reached no `WorldChangeObserver` or `RenderSlotObserver` notification: fix the notifier, not the check.
 * Imports only the switch module, so test files that never build a runtime pay nothing.
 */
import { afterAll, afterEach, expect } from "vitest";
import {
  resetSnapshotPublishVerification,
  snapshotPublishVerification,
  verifySnapshotPublishes,
} from "../snapshot-verification";

verifySnapshotPublishes(true);

function expectNoMismatch(): void {
  const { mismatches, samples } = snapshotPublishVerification();
  resetSnapshotPublishVerification();
  expect(mismatches, `Snapshot publishes differed from a whole-World pass:\n${samples.join("\n")}`).toBe(0);
}

afterEach(expectNoMismatch);
afterAll(expectNoMismatch);

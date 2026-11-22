import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@haptic/core";
import { SNAPSHOT_VERIFICATION_KEY } from "../lib/snapshot-verification-setting";
import { playSessionLoad } from "./play-session-boot";
import type { PlaySessionOptions } from "./play-session-types";

const testMode = vi.hoisted(() => ({ enabled: false }));
vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  isTestModeEnabled: () => testMode.enabled,
}));

function load(stored: string | null) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => (key === SNAPSHOT_VERIFICATION_KEY ? stored : null) });
  const options = { scene: createDefaultScene() } as unknown as PlaySessionOptions;
  return playSessionLoad(options, false).loadControl;
}

describe("Play snapshot verification switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    testMode.enabled = false;
  });

  it("asks the runtime to verify snapshot publishes when a test-mode editor has the switch stored", () => {
    testMode.enabled = true;
    expect(load("on").verifySnapshotPublishes).toBe(true);
    expect(load(null)).not.toHaveProperty("verifySnapshotPublishes");
  });

  it("never verifies outside test mode, whatever storage holds", () => {
    expect(load("on")).not.toHaveProperty("verifySnapshotPublishes");
  });
});

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeGoldenText,
  readGolden,
  writeGolden,
} from "./golden";
import { runDeterministicScenario } from "./harness";
import {
  assertHarnessFixtureReadable,
  installHarnessProjectFixtures,
} from "./harness-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

describe("deterministic runtime harness", () => {
  it("installs fake VFS project fixtures readable from memory storage", async () => {
    const { storage, paths } = await installHarnessProjectFixtures();
    expect(paths).toContain("project.json");
    expect(paths).toContain("assets/Enemy.class.json");
    const bytes = await assertHarnessFixtureReadable(
      storage,
      "assets/Enemy.class.json",
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("reproduces a 120-tick snapshot exactly (acceptance)", () => {
    const a = runDeterministicScenario({ seed: 20260811, ticks: 120 });
    const b = runDeterministicScenario({ seed: 20260811, ticks: 120 });
    expect(a.snapshotText).toBe(b.snapshotText);
    expect(a.snapshot.tickIndex).toBe(120);
    expect(a.snapshot.actors).toHaveLength(2);
    expect(a.snapshot.gameInstance?.variables.ticks).toBe(120);

    const goldenPath = join("goldens", "p3-120-tick.snapshot.json");
    if (UPDATE_GOLDEN) {
      writeGolden(HERE, goldenPath, a.snapshotText);
    }
    const golden = normalizeGoldenText(readGolden(HERE, goldenPath));
    expect(normalizeGoldenText(a.snapshotText)).toBe(golden);
  });
});

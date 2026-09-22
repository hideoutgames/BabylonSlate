import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeHostMemory } from "./host-memory.mjs";
import { resourceReport } from "./test-resources.mjs";

test("unknown constraints and failed Windows probes remain explicit", async () => {
  const observation = await observeHostMemory({
    platform: "win32",
    totalmem: () => 16,
    availableMemory: () => 5,
    constrainedMemory: () => 0,
    windowsProbe: () => {
      throw new Error("denied");
    },
  });
  assert.equal(observation.effectiveLimitBytes, 16);
  assert.equal(observation.constrainedBytes, null);
  assert.equal(observation.systemCommitAvailableBytes, null);
  assert.match(observation.errors.join(), /unavailable/);
  const constrained = await observeHostMemory({
    platform: "linux",
    totalmem: () => 16,
    availableMemory: () => 5,
    constrainedMemory: () => 8,
  });
  assert.equal(constrained.effectiveLimitBytes, 8);
});

test("diagnostics expose owned reservations without secrets or unrelated environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "resource-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "queue"));
  await writeFile(
    join(directory, "queue", "owned.json"),
    JSON.stringify({
      pid: 123,
      active: true,
      token: "private-ticket-token",
      command: "private-command",
      request: { workers: 1, memoryGiB: 2, browsers: 0 },
      policy: {
        command: "private-policy-command",
        capacity: { secret: "private-capacity-value" },
      },
    }),
  );
  const report = await resourceReport({
    directory,
    env: {
      BL_LOCAL_RESOURCE_CONFIG: join(directory, "missing.json"),
      API_TOKEN: "private-api-token",
    },
    observeMemory: () => ({ availableBytes: null, errors: ["unavailable"] }),
  });
  assert.equal(report.tickets[0].reservation.memoryGiB, 2);
  assert.deepEqual(report.errors, ["unavailable"]);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});

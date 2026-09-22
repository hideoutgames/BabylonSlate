import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJobRunner, validateWorkflowRunners } from "./workflow-runner-policy.mjs";

test("every checked-in workflow uses standard hosted runners", async () => {
  for (const file of await readdir(".github/workflows")) {
    if (/\.ya?ml$/.test(file)) await validateWorkflowRunners(process.cwd(), `.github/workflows/${file}`);
  }
});

test("runner selection rejects premium, self-hosted, grouped, and uncontrolled expressions", () => {
  for (const label of ["ubuntu-latest-4-cores", "macos-latest-xl", "self-hosted", ["ubuntu-latest"], { group: "custom" }, "${{ inputs.runner }}", "${{ matrix.os || 'ubuntu-latest' }}"]) {
    assert.throws(() => validateJobRunner({ "runs-on": label }, "fixture"), /standard/);
  }
  for (const matrix of ["${{ fromJSON(inputs.matrix) }}", { os: ["ubuntu-latest", "ubuntu-paid"] }, { os: ["ubuntu-latest"], include: [{ os: "self-hosted" }] }, { include: [{ other: "ubuntu-latest" }] }]) {
    assert.throws(() => validateJobRunner({ "runs-on": "${{ matrix.os }}", strategy: { matrix } }, "fixture"), /standard/);
  }
  validateJobRunner({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: ["ubuntu-latest", "windows-2025"], include: [{ os: "macos-26" }] } } }, "fixture");
});

test("a local reusable workflow cannot hide an unsafe runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, ".github/workflows/parent.yml"), "jobs:\n  call:\n    uses: ./.github/workflows/child.yml\n");
  const child = join(root, ".github/workflows/child.yml");
  await writeFile(child, "jobs:\n  check:\n    runs-on: ubuntu-latest-4-cores\n");
  await assert.rejects(validateWorkflowRunners(root, ".github/workflows/parent.yml"), /child.yml\/check/);
  await writeFile(child, "jobs:\n  check:\n    runs-on: ubuntu-latest\n");
  await validateWorkflowRunners(root, ".github/workflows/parent.yml");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process-runner.mjs";
import { sourceState, changedFiles } from "./source-state.mjs";

test("selection includes both sides of renames, untracked files, and changes since the base", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "selection repo "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await runCommand("git", args, { cwd, capture: true });
    assert.equal(result.code, 0, result.output);
    return result.output.trim();
  };
  await git("init", "-q");
  await writeFile(join(cwd, "old name.ts"), "one\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "Initial",
  );
  const base = await git("rev-parse", "HEAD");
  const clean = await sourceState(cwd);
  await rename(join(cwd, "old name.ts"), join(cwd, "new name.ts"));
  await writeFile(join(cwd, "untracked.ts"), "one\n");
  assert.deepEqual(await changedFiles(cwd, base), [
    "new name.ts",
    "old name.ts",
    "untracked.ts",
  ]);
  const dirty = await sourceState(cwd);
  assert.equal(clean.clean, true);
  assert.equal(dirty.clean, false);
  await writeFile(join(cwd, "untracked.ts"), "two\n");
  assert.notEqual((await sourceState(cwd)).digest, dirty.digest);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const workflow = parse(await readFile(".github/workflows/distribute.yml", "utf8"));

test("native and publishing jobs cannot execute during dry run", () => {
  for (const name of ["windows", "macos", "linux", "android", "ipados", "testflight", "publish-release"]) {
    assert.match(workflow.jobs[name].if, /needs\.validate\.outputs\.dry_run != 'true'/);
    assert.ok(workflow.jobs[name].needs.includes("validate"));
  }
  assert.ok(workflow.jobs.validate.steps.every(step => !/ios:archive|package:(?:windows|macos|linux)|android:release|publish-release|finalize-testflight/.test(step.run ?? "")));
});

test("distribution uses standard runners, pinned actions and scoped artifact uploads", () => {
  const uploadJobs = new Set(["windows", "macos", "linux", "android"]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.match(job["runs-on"], /^(ubuntu-24\.04|windows-2025|macos-26)$/);
    if (name !== "publish-release") assert.notEqual(job.permissions?.contents, "write");
    let uploads = 0;
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
      if (step.uses?.startsWith("actions/upload-artifact@")) uploads += 1;
    }
    assert.equal(uploads > 0, uploadJobs.has(name));
  }
});

test("ordinary build and verification commands do not perform distribution", async () => {
  const distributionCommand = /ios:archive|package:(?:windows|macos|linux)|android:release|publish-release|finalize-testflight|generate-metadata/;
  for (const path of ["package.json", "apps/editor/package.json", "apps/desktop/package.json"]) {
    const { scripts } = JSON.parse(await readFile(path, "utf8"));
    for (const name of ["build", "verify", "typecheck", "test", "test:distribution"]) assert.doesNotMatch(scripts[name] ?? "", distributionCommand);
  }
  const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
  assert.equal(desktop.scripts.build, undefined);
  for (const path of ["verify.yml", "preview.yml", "security.yml", "webkit-smoke.yml"]) {
    assert.doesNotMatch(await readFile(`.github/workflows/${path}`, "utf8"), /scripts\/distribution|distribute\.yml|ios:archive|package:(?:windows|macos|linux)|android:release|publish-release/);
  }
});

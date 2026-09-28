import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const workflow = parse(await readFile(".github/workflows/distribute.yml", "utf8"));
const inspection = parse(await readFile(".github/workflows/inspect-desktop-packaging.yml", "utf8"));
const appleInspection = parse(await readFile(".github/workflows/inspect-apple-toolchain.yml", "utf8"));
const androidInspection = parse(await readFile(".github/workflows/inspect-android-toolchain.yml", "utf8"));

test("distribution has only a manual trigger, explicit channels and exact platform choices", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["test", "release"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.channel.default, "test");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ["all", "desktop", "mobile", "ipados", "android", "windows", "macos", "linux"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.platforms.default, "all");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.permissions.contents, "read");
});

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

test("signing and publication jobs use the intended environments and permissions", () => {
  assert.equal(workflow.jobs.macos.environment, "macos-signing");
  assert.equal(workflow.jobs.android.environment, "android-signing");
  assert.equal(workflow.jobs.ipados.environment, "testflight");
  assert.equal(workflow.jobs.testflight.environment, "testflight");
  assert.equal(workflow.jobs["publish-release"].environment, "github-release");
  assert.equal(workflow.jobs["publish-release"].permissions.contents, "write");
});

test("ordinary build and verification commands do not perform distribution", async () => {
  const distributionCommand = /ios:archive|package:(?:windows|macos|linux)|android:release|publish-release|finalize-testflight|generate-metadata/;
  for (const path of ["package.json", "apps/editor/package.json", "apps/desktop/package.json"]) {
    const { scripts } = JSON.parse(await readFile(path, "utf8"));
    for (const name of ["build", "verify", "typecheck", "test", "test:distribution"]) assert.doesNotMatch(scripts[name] ?? "", distributionCommand);
  }
  const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
  assert.equal(desktop.scripts.build, undefined);
  for (const path of ["verify.yml", "preview.yml", "security.yml"]) {
    assert.doesNotMatch(await readFile(`.github/workflows/${path}`, "utf8"), /scripts\/distribution|distribute\.yml|ios:archive|package:(?:windows|macos|linux)|android:release|publish-release/);
  }
});

test("desktop inspection plans only the requested standard hosts", () => {
  assert.deepEqual(Object.keys(inspection.on), ["workflow_dispatch"]);
  assert.deepEqual(inspection.on.workflow_dispatch.inputs.platform.options, ["all", "windows", "macos", "linux"]);
  assert.deepEqual(inspection.on.workflow_dispatch.inputs.channel.options, ["test", "release"]);
  assert.equal(inspection.permissions.contents, "read");
  const hosts = { windows: "windows-2025", macos: "macos-26", linux: "ubuntu-24.04" };
  assert.deepEqual(Object.keys(inspection.jobs), Object.keys(hosts));
  for (const [platform, runner] of Object.entries(hosts)) {
    const job = inspection.jobs[platform];
    assert.equal(job["runs-on"], runner);
    assert.equal(job.if, `inputs.platform == 'all' || inputs.platform == '${platform}'`);
    assert.equal(job.environment, undefined);
    assert.ok(job.steps.some(step => step.run === `pnpm --filter desktop package:${platform}`));
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      assert.ok(!step.uses?.startsWith("actions/upload-artifact@"));
    }
  }
});

test("Apple and Android toolchain inspections are manual, read-only and action-pinned", () => {
  for (const inspected of [appleInspection, androidInspection]) {
    assert.deepEqual(Object.keys(inspected.on), ["workflow_dispatch"]);
    assert.equal(inspected.permissions.contents, "read");
    for (const job of Object.values(inspected.jobs)) {
      assert.match(job["runs-on"], /^(ubuntu-24\.04|macos-26)$/);
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
        assert.ok(!step.uses?.startsWith("actions/upload-artifact@"));
      }
    }
  }
});

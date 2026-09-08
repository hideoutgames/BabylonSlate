import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const workflow = parse(await readFile(".github/workflows/distribute.yml", "utf8"));
test("distribution has only a manual trigger, explicit channels and no interrupting concurrency", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["test", "release"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.channel.default, "test");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.permissions.contents, "read");
});

test("native and publishing jobs cannot execute during dry run", () => {
  for (const name of ["windows", "ipados", "testflight", "publish-windows"]) {
    assert.match(workflow.jobs[name].if, /needs\.validate\.outputs\.dry_run != 'true'/);
    assert.ok(workflow.jobs[name].needs.includes("validate"));
  }
  assert.ok(workflow.jobs.validate.steps.every(step => !/archive|package:windows|publish-windows|finalize-testflight/.test(step.run ?? "")));
});

test("distribution uses standard runners, pinned actions, scoped environments and checkout without credentials", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.match(job["runs-on"], /^(ubuntu-24\.04|windows-2025|macos-26)$/);
    if (name !== "publish-windows") assert.notEqual(job.permissions?.contents, "write");
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
      if (name !== "windows") assert.ok(!step.uses?.startsWith("actions/upload-artifact@"));
    }
  }
  assert.equal(workflow.jobs.ipados.environment, "testflight");
  assert.equal(workflow.jobs.testflight.environment, "testflight");
  assert.equal(workflow.jobs["publish-windows"].environment, "github-release");
  assert.equal(workflow.jobs["publish-windows"].permissions.contents, "write");
});

test("ordinary build and verification commands do not perform distribution", async () => {
  for (const path of ["package.json", "apps/editor/package.json", "apps/desktop/package.json"]) {
    const { scripts } = JSON.parse(await readFile(path, "utf8"));
    for (const name of ["build", "verify", "typecheck", "test", "test:distribution"]) {
      assert.doesNotMatch(scripts[name] ?? "", /ios:archive|package:windows|publish-windows|finalize-testflight|generate-metadata/);
    }
  }
  const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
  assert.equal(desktop.scripts.build, undefined);
  for (const path of ["verify.yml", "preview.yml", "security.yml"]) {
    assert.doesNotMatch(await readFile(`.github/workflows/${path}`, "utf8"), /distribute\.yml|ios:archive|package:windows|publish-windows\.mjs/);
  }
});

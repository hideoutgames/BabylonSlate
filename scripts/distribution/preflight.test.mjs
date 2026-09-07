import assert from "node:assert/strict";
import test from "node:test";
import { preflight } from "./preflight.mjs";

const sha = "a".repeat(40);
const request = { channel: "test", platforms: "both", version: "1.0.0", sourceSha: sha, runNumber: 4, runAttempt: 1, workflowRef: "refs/heads/main", eventName: "workflow_dispatch", dryRun: true };
function fixture(patch = {}) {
  const reads = [];
  const dependencies = {
    repository: "owner/repo",
    git: async (args) => args[0] === "show" ? JSON.stringify({ version: "1.0.0", appleSequenceOffset: 0 }) : "",
    api: async (path) => {
      reads.push(path);
      if (path === "/branches/main") return { protected: true, protection: { required_status_checks: { contexts: [] } } };
      if (path === "/rules/branches/main") return [];
      if (path.startsWith("/actions/workflows/verify.yml/runs")) return { workflow_runs: [{ id: 42, head_sha: sha, status: "completed", conclusion: "success", event: "push" }] };
      if (path === "/actions/runs/42/jobs?per_page=100&filter=latest") return { jobs: ["static", "unit", ...Array.from({ length: 7 }, (_, i) => `e2e (${i + 1})`)].map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" })) };
      if (path.startsWith("/git/ref/tags/") || path.startsWith("/releases/tags/")) return null;
      throw new Error(`Unexpected read ${path}`);
    },
    ...patch,
  };
  return { dependencies, reads };
}

test("dry run resolves destinations using read-only dependencies, without native work", async () => {
  const { dependencies, reads } = fixture();
  const result = await preflight(request, dependencies);
  assert.equal(result.identity.tag, "v1.0.0-indev.4.1");
  assert.equal(result.dryRun, true);
  assert.ok(reads.includes("/branches/main"));
});

test("source ancestry and missing exact-commit Verify fail before destinations", async () => {
  const unreachable = fixture({ git: async () => { throw new Error("not ancestor"); } });
  await assert.rejects(preflight(request, unreachable.dependencies));
  const original = fixture();
  const missing = fixture({ api: async path => path.startsWith("/actions/workflows/") ? { workflow_runs: [] } : original.dependencies.api(path) });
  await assert.rejects(preflight(request, missing.dependencies), /Verify/);
});

test("release channel never substitutes an ancestor's successful checks", async () => {
  const original = fixture();
  const wrong = fixture({ api: async path => path.startsWith("/actions/workflows/") ? { workflow_runs: [{ id: 42, head_sha: "b".repeat(40), status: "completed", conclusion: "success" }] } : original.dependencies.api(path) });
  await assert.rejects(preflight({ ...request, channel: "release" }, wrong.dependencies), /Verify/);
});

test("published Windows release and conflicting annotated tags fail preflight", async () => {
  for (const conflict of ["release", "tag"]) {
    const original = fixture();
    const changed = fixture({ api: async path => {
      if (conflict === "release" && path.startsWith("/releases/tags/")) return { draft: false };
      if (conflict === "tag" && path.startsWith("/git/ref/tags/")) return { object: { type: "commit", sha: "b".repeat(40) } };
      return original.dependencies.api(path);
    } });
    await assert.rejects(preflight(request, changed.dependencies), /immutable|another source/);
  }
});

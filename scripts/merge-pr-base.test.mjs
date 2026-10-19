import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergePullRequestBase } from "./merge-pr-base.mjs";

const script = fileURLToPath(new URL("./merge-pr-base.mjs", import.meta.url));

function gitIn(cwd) {
  return (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
}

async function commitFile(cwd, name, content, message) {
  await writeFile(join(cwd, name), content);
  const git = gitIn(cwd);
  git("add", name);
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );
  return git("rev-parse", "HEAD");
}

/**
 * `origin` holds main and the pull-request branch. `work` is a clone with the
 * head checked out detached, as actions/checkout leaves it; `cloneWork` makes
 * another such checkout, like a second job of the same run. `moveBase` then
 * lands another change on origin's main, which no checkout has fetched.
 */
async function pullRequestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "merge-pr-base "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  gitIn(root)("init", "-q", "-b", "main", origin);
  await commitFile(origin, "a.txt", "base\n", "Add a");
  await commitFile(origin, "b.txt", "base\n", "Add b");
  const author = join(root, "author");
  gitIn(root)("clone", "-q", origin, author);
  gitIn(author)("switch", "-q", "-c", "feature");
  const headSha = await commitFile(author, "a.txt", "feature\n", "Change a");
  gitIn(author)("push", "-q", "origin", "feature");
  const cloneWork = (name) => {
    const work = join(root, name);
    gitIn(root)("clone", "-q", origin, work);
    gitIn(work)("checkout", "-q", "--detach", headSha);
    return work;
  };
  const work = cloneWork("work");
  return {
    work,
    git: gitIn(work),
    headSha,
    cloneWork,
    moveBase: (name, content) =>
      commitFile(origin, name, content, `Change ${name} on main`),
  };
}

test("merges the base branch tip as it is now, not the base the branch was cut from", async (t) => {
  const { work, git, headSha, moveBase } = await pullRequestFixture(t);
  const staleBase = git("rev-parse", "refs/remotes/origin/main");
  const baseSha = await moveBase("b.txt", "landed after the checkout\n");
  const lines = [];

  const result = mergePullRequestBase({
    cwd: work,
    baseRef: "main",
    headSha,
    log: (line) => lines.push(line),
  });

  assert.notEqual(baseSha, staleBase);
  assert.equal(result.baseSha, baseSha);
  assert.equal(result.mergedSha, git("rev-parse", "HEAD"));
  assert.equal(git("rev-list", "--parents", "-n", "1", "HEAD"), [
    result.mergedSha,
    headSha,
    baseSha,
  ].join(" "));
  assert.equal(await readFile(join(work, "a.txt"), "utf8"), "feature\n");
  assert.equal(
    await readFile(join(work, "b.txt"), "utf8"),
    "landed after the checkout\n",
  );
  assert.deepEqual(lines, [
    `Testing pull request head ${headSha} merged with main ${baseSha} as ${result.mergedSha}`,
  ]);
  const localIdentity = spawnSync("git", ["config", "--local", "user.name"], {
    cwd: work,
  });
  assert.equal(localIdentity.status, 1, "The identity must not be persisted");
});

test("jobs that merge the same base create the same commit", async (t) => {
  const { work, cloneWork, headSha, moveBase } = await pullRequestFixture(t);
  await moveBase("b.txt", "landed after the checkout\n");
  const options = { baseRef: "main", headSha, log: () => {} };

  const first = mergePullRequestBase({ cwd: work, ...options });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = mergePullRequestBase({ cwd: cloneWork("other job"), ...options });

  assert.equal(second.mergedSha, first.mergedSha);
});

test("a head that already contains the base is tested unchanged", async (t) => {
  const { work, git, headSha } = await pullRequestFixture(t);
  const lines = [];

  const result = mergePullRequestBase({
    cwd: work,
    baseRef: "main",
    headSha,
    log: (line) => lines.push(line),
  });

  assert.equal(result.mergedSha, headSha);
  assert.equal(git("rev-parse", "HEAD"), headSha);
  assert.match(lines.join("\n"), /the head already contains the base/);
});

test("fails instead of skipping the merge when the head or the base cannot be used", async (t) => {
  const { work, headSha } = await pullRequestFixture(t);
  const otherSha = "0".repeat(40);

  assert.throws(
    () => mergePullRequestBase({ cwd: work, baseRef: "main", headSha: otherSha }),
    /to be checked out/,
  );
  assert.throws(
    () => mergePullRequestBase({ cwd: work, baseRef: "main", headSha: "main" }),
    /full commit SHA/,
  );
  assert.throws(
    () => mergePullRequestBase({ cwd: work, baseRef: "gone", headSha }),
    /git fetch failed/,
  );
});

test("the entry point reads BASE_REF and HEAD_SHA and prints one line", async (t) => {
  const { work, headSha, moveBase } = await pullRequestFixture(t);
  const baseSha = await moveBase("b.txt", "landed after the checkout\n");

  const result = spawnSync(process.execPath, [script], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, BASE_REF: "main", HEAD_SHA: headSha },
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    new RegExp(
      `^Testing pull request head ${headSha} merged with main ${baseSha} as [0-9a-f]{40}$`,
    ),
  );
});

test("a conflict with the base fails naming the base commit and leaves the head checked out", async (t) => {
  const { work, git, headSha, moveBase } = await pullRequestFixture(t);
  const baseSha = await moveBase("a.txt", "main\n");

  const result = spawnSync(process.execPath, [script], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_REF: "main",
      HEAD_SHA: headSha,
      GITHUB_ACTIONS: "true",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^::error title=Verify base merge::/);
  assert.ok(
    result.stderr.includes(
      `Pull request head ${headSha} conflicts with main at ${baseSha} in a.txt.`,
    ),
    result.stderr,
  );
  assert.equal(git("rev-parse", "HEAD"), headSha);
  assert.equal(git("status", "--porcelain"), "");
});

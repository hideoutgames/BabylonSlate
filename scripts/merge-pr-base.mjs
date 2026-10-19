#!/usr/bin/env node
// Makes a pull-request Verify job test what would land on the base branch now.
//
// GitHub's default pull_request checkout (refs/pull/N/merge) is a cached test
// merge that GitHub recomputes lazily, not whenever the base branch moves, so a
// job can test a merge on a base that has since gained other pull requests.
// Verify checks out the pull-request head commit instead and runs this script,
// which fetches the live tip of the base branch and merges it into the head.
//
// Usage (the working directory is a full-history checkout of the head commit):
//   BASE_REF=main HEAD_SHA=<head sha> node scripts/merge-pr-base.mjs

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The identity exists only for the merge command (-c), never in any git config.
const mergeIdentity = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "-c",
  "commit.gpgsign=false",
];
const maxListedFiles = 10;

function run(cwd, args, env = process.env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

function git(cwd, args) {
  const result = run(cwd, args);
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.stdout;
}

/**
 * Merges the current tip of `remote/baseRef` into the checked-out pull-request
 * head with a real merge commit and logs one line naming the head, the base and
 * the tested commit. A conflict aborts the merge and throws an error naming the
 * base commit, so the job fails with a message the author can act on.
 */
export function mergePullRequestBase({
  cwd = process.cwd(),
  baseRef,
  headSha,
  remote = "origin",
  log = console.log,
}) {
  if (!baseRef) throw new Error("BASE_REF is missing: set the base branch.");
  if (!/^[0-9a-f]{40}$/.test(headSha ?? ""))
    throw new Error(`HEAD_SHA must be a full commit SHA, got "${headSha}".`);
  const checkedOut = git(cwd, ["rev-parse", "HEAD"]);
  if (checkedOut !== headSha)
    throw new Error(
      `Expected the pull request head ${headSha} to be checked out, found ${checkedOut}.`,
    );

  // Always the live tip, never a base ref fetched earlier or refs/pull/N/merge.
  git(cwd, [
    "fetch",
    "--no-tags",
    "--quiet",
    remote,
    `+refs/heads/${baseRef}:refs/remotes/${remote}/${baseRef}`,
  ]);
  const baseSha = git(cwd, [
    "rev-parse",
    "--verify",
    `refs/remotes/${remote}/${baseRef}^{commit}`,
  ]);

  // Dated by its parents, so every job that merges the same base creates the
  // same commit and the logs of a run's jobs can be compared by SHA.
  const newest = Math.max(
    ...[headSha, baseSha].map((sha) =>
      Number(git(cwd, ["log", "-1", "--format=%ct", sha])),
    ),
  );
  const date = `${newest} +0000`;
  const merge = run(
    cwd,
    [
      ...mergeIdentity,
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `Merge ${baseRef} ${baseSha} into pull request head ${headSha}`,
      baseSha,
    ],
    { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  if (!merge.ok) {
    if (!run(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]).ok)
      throw new Error(
        `Merging ${baseRef} at ${baseSha} into pull request head ${headSha} failed: ${merge.output}`,
      );
    const files = run(cwd, ["diff", "--name-only", "--diff-filter=U"])
      .stdout.split("\n")
      .filter(Boolean);
    run(cwd, ["merge", "--abort"]);
    const listed = files.slice(0, maxListedFiles).join(", ");
    const more =
      files.length > maxListedFiles
        ? `, and ${files.length - maxListedFiles} more`
        : "";
    throw new Error(
      `Pull request head ${headSha} conflicts with ${baseRef} at ${baseSha} in ${listed}${more}. Merge or rebase ${baseRef} into the branch and push to rerun Verify.`,
    );
  }

  const mergedSha = git(cwd, ["rev-parse", "HEAD"]);
  log(
    `Testing pull request head ${headSha} merged with ${baseRef} ${baseSha} as ${mergedSha}${mergedSha === headSha ? " (the head already contains the base)" : ""}`,
  );
  return { headSha, baseSha, mergedSha };
}

function main() {
  try {
    mergePullRequestBase({
      baseRef: process.env.BASE_REF,
      headSha: process.env.HEAD_SHA,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An annotation puts the message on the run summary, not only in the step log.
    console.error(
      process.env.GITHUB_ACTIONS === "true"
        ? `::error title=Verify base merge::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`
        : message,
    );
    process.exitCode = 1;
  }
}

/** Compares resolved file URLs, so Windows paths and symlinked entries still run. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}

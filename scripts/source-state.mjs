import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process-runner.mjs";

export async function gitOutput(cwd, args) {
  const result = await runCommand("git", args, { cwd, capture: true });
  if (result.code) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.output;
}
export async function sourceState(cwd) {
  const commit = (await gitOutput(cwd, ["rev-parse", "HEAD"])).trim();
  const status = await gitOutput(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const diff = await gitOutput(cwd, [
    "diff",
    "HEAD",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
  ]);
  const hash = createHash("sha256").update(commit).update(status).update(diff);
  for (const file of (
    await gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(cwd, file)))
      .update("\0");
  }
  return { commit, digest: hash.digest("hex"), clean: status === "" };
}
export async function changedFiles(cwd, base) {
  const changed = await gitOutput(cwd, [
    "diff",
    base,
    "--name-only",
    "--no-renames",
    "-z",
  ]);
  const untracked = await gitOutput(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return [...new Set((changed + untracked).split("\0").filter(Boolean))].sort();
}

import type { ChangeKind, PullChoices, PullConflict } from "./sync-port";

/** A file the remote changed since the merge base; ids are content ids, null when absent. */
export interface IncomingFile {
  path: string;
  base: string | null;
  theirs: string | null;
  /** The working tree's file now, committed or not. */
  mine: string | null;
}

export interface PullPlan {
  conflicts: PullConflict[];
  /** Paths to take from the remote (sorted as given). */
  writes: string[];
  /** Conflicting paths whose working file stays. */
  kept: string[];
  /** Every conflict has a choice. */
  ready: boolean;
}

function changeKind(base: string | null, side: string | null): ChangeKind {
  if (base === null) return "added";
  return side === null ? "deleted" : "modified";
}

/**
 * Whole-file integration, shared by the Git client and the fake: a file the
 * working tree left as it was at the merge base, or already matches, takes the
 * remote's version; one changed on both sides is a conflict that needs a choice.
 */
export function planPull(incoming: readonly IncomingFile[], choices: PullChoices = {}): PullPlan {
  const plan: PullPlan = { conflicts: [], writes: [], kept: [], ready: true };
  for (const file of incoming) {
    if (file.mine === file.theirs || file.mine === file.base) {
      plan.writes.push(file.path);
      continue;
    }
    plan.conflicts.push({ path: file.path, mine: changeKind(file.base, file.mine), theirs: changeKind(file.base, file.theirs) });
    const choice = choices[file.path];
    if (choice === "theirs") plan.writes.push(file.path);
    else if (choice === "mine") plan.kept.push(file.path);
    else plan.ready = false;
  }
  return plan;
}

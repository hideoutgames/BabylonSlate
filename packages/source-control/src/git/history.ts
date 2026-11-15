/** A commit as the history walk needs it; null when the object is not in this (shallow) copy. */
export interface CommitNode {
  parents: string[];
  /** Committer time, seconds. */
  timestamp: number;
}

export interface Relation {
  /** The newest commit both sides reach, or null when none was found. */
  base: string | null;
  /** Commits only the local side reaches, newest first (commit time; ties in walk order). */
  ahead: string[];
  /** Commits only the remote side reaches, newest first (commit time; ties in walk order). */
  behind: string[];
  /** The walk reached a commit whose parents this shallow copy lacks. */
  truncated: boolean;
}

const LOCAL = 1;
const REMOTE = 2;
const BOTH = LOCAL | REMOTE;

/**
 * Splits two sides' history into what only each side reaches and their
 * merge base, newest first (as `git rev-list --left-right` paints it): the
 * walk stops once every commit still queued is reached by both sides, so it
 * reads only the commits since the fork. The remote side is one or more
 * commits: a branch's remote branch, or before its first push every remote
 * branch this copy fetched (as git-lfs counts a new branch's objects); with
 * none (nothing pushed yet) every local commit is ahead. `shallow` commits'
 * parents are not followed.
 */
export async function relate(
  local: string,
  remotes: readonly string[],
  read: (oid: string) => Promise<CommitNode | null>,
  shallow: ReadonlySet<string>,
): Promise<Relation> {
  const marks = new Map<string, number>();
  const nodes = new Map<string, CommitNode | null>();
  const queue: string[] = [];
  let truncated = false;
  let base: string | null = null;

  const node = async (oid: string) => {
    if (!nodes.has(oid)) nodes.set(oid, await read(oid));
    return nodes.get(oid) ?? null;
  };
  const enqueue = async (oid: string, flags: number) => {
    const before = marks.get(oid) ?? 0;
    const after = before | flags;
    if (after === before) return;
    marks.set(oid, after);
    if (!(await node(oid))) {
      truncated = true;
      return;
    }
    if (!queue.includes(oid)) queue.push(oid);
  };
  const time = (oid: string) => nodes.get(oid)?.timestamp ?? 0;

  await enqueue(local, LOCAL);
  for (const remote of remotes) await enqueue(remote, REMOTE);
  while (queue.some((oid) => marks.get(oid) !== BOTH)) {
    queue.sort((a, b) => time(b) - time(a));
    const oid = queue.shift()!;
    const flags = marks.get(oid)!;
    if (flags === BOTH) base ??= oid;
    if (shallow.has(oid)) {
      truncated = true;
      continue;
    }
    for (const parent of (await node(oid))!.parents) await enqueue(parent, flags);
  }
  if (base === null) {
    queue.sort((a, b) => time(b) - time(a));
    base = queue.find((oid) => marks.get(oid) === BOTH) ?? null;
  }
  // Sorting is stable: commits of one second keep the walk's order, which reaches newer ones first.
  const only = (side: number) =>
    [...marks].filter(([oid, flags]) => flags === side && nodes.get(oid)).map(([oid]) => oid).sort((a, b) => time(b) - time(a));
  return { base, ahead: only(LOCAL), behind: only(REMOTE), truncated };
}

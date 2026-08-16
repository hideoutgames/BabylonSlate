/** Returns a holder message when any path is locked by someone else. */
export function refuseTheirsPaths(
  paths: string[],
  refuseIfTheirs: (path: string) => string | null,
): string | null {
  for (const path of paths) {
    const message = refuseIfTheirs(path);
    if (message) return message;
  }
  return null;
}

/** Paths we hold, so a delete can unlock the old LFS path. */
export function oursLockPaths(
  paths: string[],
  lockStateForPath: (path: string) => "mine" | "theirs" | null,
): string[] {
  return paths.filter((path) => lockStateForPath(path) === "mine");
}

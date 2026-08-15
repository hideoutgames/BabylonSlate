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

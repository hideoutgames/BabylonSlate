/** Paths that keep their identity on supported case-insensitive and Windows filesystems. */
export function isPortablePackagePath(path: string): boolean {
  return path.length > 0 && !/[\\:*?"<>|]/.test(path) && ![...path].some((character) => character.charCodeAt(0) < 32) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." &&
      !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

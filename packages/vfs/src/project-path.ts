/** Validate before crossing a native filesystem boundary. */
export function projectRelativePath(path: string, allowRoot = false): string {
  if (path === "") {
    if (allowRoot) return path;
    throw new Error("Cannot mutate or read the project root as a file");
  }
  if (path.includes("\\") || path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Path escapes project root: ${path}`);
  }
  return path;
}

export function projectFolderName(name: string): string {
  projectRelativePath(name);
  if (name.includes("/")) throw new Error("Project name must be a single folder name");
  return name;
}

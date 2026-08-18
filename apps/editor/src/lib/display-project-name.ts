/** Strip the project-folder suffix for chrome and homepage labels. */
export function displayProjectName(name: string): string {
  return name.replace(/\.babproject$/i, "");
}

/** Export Project download filename: display name with spaces as `_`, `.zip`. */
export function projectArchiveDownloadName(name: string): string {
  return `${displayProjectName(name).replace(/\s+/g, "_")}.zip`;
}

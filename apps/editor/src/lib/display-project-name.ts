/** Export Project download filename: project name with spaces as `_`, `.zip`. */
export function projectArchiveDownloadName(name: string): string {
  return `${name.replace(/\s+/g, "_")}.zip`;
}

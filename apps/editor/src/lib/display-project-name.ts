/** Strip the project-folder suffix for chrome and homepage labels. */
export function displayProjectName(name: string): string {
  return name.replace(/\.babproject$/i, "");
}

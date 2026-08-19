import { displayProjectName } from "./display-project-name";

/** Display name shown in the Create Project dialog. */
export function defaultCreateProjectDisplayName(testMode: boolean): string {
  return testMode ? "TestProject" : "";
}

/** Folder name written to storage; empty when the display name is blank. */
export function normalizeProjectFolderName(displayName: string): string {
  return displayProjectName(displayName.trim());
}

export type CreateProjectNameIssue = "Name required." | "Name already exists.";

/** Validation copy for the Create Project name field. */
export function createProjectNameIssue(
  displayName: string,
  existingFolderNames: readonly string[],
): CreateProjectNameIssue | null {
  const folder = normalizeProjectFolderName(displayName);
  if (!folder) return "Name required.";
  const wanted = folder.toLowerCase();
  const taken = existingFolderNames.some(
    (name) => normalizeProjectFolderName(name).toLowerCase() === wanted,
  );
  return taken ? "Name already exists." : null;
}

export type CreateProjectOptions = {
  /** Native only: pick an external folder, then scaffold into it. */
  pickFolder?: boolean;
  /** Built-in card: Empty (3D cube) or 2D (pixel-perfect, Rapier, no cube). */
  kind?: "empty" | "2d";
  renderWidth?: number;
  renderHeight?: number;
  blackBars?: boolean;
};

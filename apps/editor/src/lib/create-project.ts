import { displayProjectName } from "./display-project-name";

/** Display name shown in the Create Project dialog (no `.babproject` suffix). */
export function defaultCreateProjectDisplayName(testMode: boolean): string {
  return testMode ? "TestProject" : "MyGame";
}

/** Folder name written to storage; empty when the display name is blank. */
export function normalizeProjectFolderName(displayName: string): string {
  const base = displayProjectName(displayName.trim());
  return base ? `${base}.babproject` : "";
}

export type CreateProjectOptions = {
  /** Native only: pick an external folder, then scaffold into it. */
  pickFolder?: boolean;
  /** Built-in card: Empty (3D cube) or 2D (pixel-perfect, Rapier, no cube). */
  kind?: "empty" | "2d";
};

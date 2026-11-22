import { normalizeProjectAppearance, normalizeProjectSettings, type ProjectDocument } from "@haptic/core";
import { createDefaultMigrationRegistry, type MigrationRegistry } from "./migration";

export const INCOMPLETE_PROJECT_MANIFEST =
  "Invalid project manifest: project.json is missing metadata, settings, scenes or graphs.";

export const PROJECT_MANIFEST_WITHOUT_GUID = "Invalid project manifest: project.json has no project guid.";

/** Whether a parsed `project.json` has every section a project needs. */
export function isCompleteProjectManifest(raw: Partial<ProjectDocument>): raw is ProjectDocument {
  return Boolean(raw.metadata && raw.settings && raw.scenes && raw.graphs);
}

/** The stored manifest with its appearance and settings normalised; one missing a section is refused. */
export function normalizeProjectDocument(raw: Partial<ProjectDocument>): ProjectDocument {
  if (!isCompleteProjectManifest(raw)) throw new Error(INCOMPLETE_PROJECT_MANIFEST);
  return {
    ...raw,
    metadata: {
      ...raw.metadata,
      appearance: normalizeProjectAppearance(raw.metadata.appearance),
    },
    settings: normalizeProjectSettings(raw.settings),
  };
}

/** A `project.json` as the editor opens it: the normalised document and the project's guid. */
export interface ProjectManifest {
  document: ProjectDocument;
  guid: string;
}

/**
 * Reads `project.json` text as opening a project does: complete sections,
 * settings and appearance normalised (an absent setting takes its default), a
 * project guid, and the current Project format version (never upgraded).
 * Throws with what is wrong. The cover picture's bytes are not read.
 */
export function readProjectManifest(text: string, migrations: MigrationRegistry = createDefaultMigrationRegistry()): ProjectManifest {
  const raw = JSON.parse(text) as Partial<ProjectDocument> & { guid?: unknown; version?: unknown };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(INCOMPLETE_PROJECT_MANIFEST);
  const document = normalizeProjectDocument(raw);
  // Every project is created with its guid, the namespace of its player saves.
  if (typeof raw.guid !== "string" || !raw.guid) throw new Error(PROJECT_MANIFEST_WITHOUT_GUID);
  // The manifest is read as stored, so it must be at the current Project version.
  migrations.requireCurrent("Project", typeof raw.version === "number" ? raw.version : migrations.currentVersion("Project"));
  return { document, guid: raw.guid };
}

import { ENGINE_VERSION } from "@haptic/core";
import { stableStringify } from "../bytes";
import {
  LAYOUT_FILE,
  PLUGIN_MANIFEST_FILE,
  PROJECT_MANIFEST_FILE,
  type HprojectManifest,
  type ManifestKind,
  type ProjectTreeFile,
} from "../hproject";

/** Fixed, so a tree's bytes are the same on every run. */
const CREATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * A bare project (manifest and layout) or plugin (manifest only) tree. A
 * project manifest has every section the editor saves: it lists no Scenes or
 * Classes, and its empty settings load as the defaults.
 */
export function createEmptyProjectFiles(options: {
  kind?: ManifestKind;
  guid: string;
  name: string;
}): ProjectTreeFile[] {
  const kind = options.kind ?? "project";
  const manifest =
    kind === "project"
      ? {
          metadata: { name: options.name, version: "1.0.0", createdAt: CREATED_AT, updatedAt: CREATED_AT },
          settings: {},
          scenes: [],
          graphs: [],
          guid: options.guid,
          kind,
          version: 1,
        }
      : ({
          kind,
          guid: options.guid,
          name: options.name,
          engineVersion: ENGINE_VERSION,
          version: 1,
        } satisfies HprojectManifest);
  const files: ProjectTreeFile[] = [
    {
      path: kind === "plugin" ? PLUGIN_MANIFEST_FILE : PROJECT_MANIFEST_FILE,
      data: new TextEncoder().encode(stableStringify(manifest)),
    },
  ];
  if (kind === "project") {
    files.push({
      path: LAYOUT_FILE,
      data: new TextEncoder().encode(
        stableStringify({ documents: {}, tabOrder: [] }),
      ),
    });
  }
  return files;
}

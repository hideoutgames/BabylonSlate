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

/** A bare project (manifest and layout) or plugin (manifest only) tree. */
export function createEmptyProjectFiles(options: {
  kind?: ManifestKind;
  guid: string;
  name: string;
  engineVersion?: string;
}): ProjectTreeFile[] {
  const kind = options.kind ?? "project";
  const manifest: HprojectManifest = {
    kind,
    guid: options.guid,
    name: options.name,
    engineVersion: options.engineVersion ?? ENGINE_VERSION,
    version: 1,
    startupScene: kind === "project" ? "assets/main.scene.hasset" : undefined,
  };
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

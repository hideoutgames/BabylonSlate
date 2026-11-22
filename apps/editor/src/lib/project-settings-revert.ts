import type { SourceControlProjectSettings } from "@haptic/core";
import { readProjectVersion } from "@haptic/assets/project-settings-diff";
import { sameRepository } from "./source-control-mode";

const MODE_NAMES: Record<string, string> = { off: "Off", manual: "Manual" };

/**
 * Why reverting Project Settings to `version`'s `project.json` (null when it
 * has none) is refused, or null. The project reloads from the reverted file,
 * so, as for a branch switch (`branchSettingsRefusal`), the version must be a
 * project the editor can open that keeps Integrated mode with this
 * repository: any other mode stops Haptic's Git client in this working copy,
 * which on iOS and Android may then have no way back.
 */
export function revertSettingsRefusal(version: string, projectJson: Uint8Array | null, repositoryUrl: string): string | null {
  if (!projectJson) return `${version} has no Project Settings to revert to: project.json is missing.`;
  let sourceControl: SourceControlProjectSettings;
  try {
    sourceControl = readProjectVersion({ bytes: projectJson, label: version })!.settings.sourceControl;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const keepOn = "Only Project Settings in Integrated mode with this repository can be reverted to here.";
  if (sourceControl.mode !== "integrated") {
    return `The Project Settings in ${version} set Source Control to ${MODE_NAMES[sourceControl.mode] ?? "Off"}, so reverting to them would stop Haptic's Git in this folder. ${keepOn}`;
  }
  if (!sameRepository(sourceControl.repositoryUrl, repositoryUrl)) {
    return `The Project Settings in ${version} use another repository (${sourceControl.repositoryUrl || "none"}), so reverting to them would stop Haptic's Git in this folder. ${keepOn}`;
  }
  return null;
}

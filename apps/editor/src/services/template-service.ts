import type { ProjectStorage } from "@babylonslate/core";
import { listTemplates, type ProjectTemplate } from "@babylonslate/assets";
import type { EngineSettings, HostPlatform } from "@babylonslate/vfs";

export interface TemplateSourceDeps {
  platform: HostPlatform;
  loadSettings: () => Promise<EngineSettings>;
  openTemplatesFolder: (folder: string) => Promise<ProjectStorage>;
}

/**
 * Homepage template cards. Web offers Empty only because it has no folder
 * picker for a templates location; other hosts read the Engine Settings folder.
 * An unreadable or unset folder means no cards rather than a failed Homepage.
 */
export async function loadTemplateCards(
  deps: TemplateSourceDeps,
): Promise<ProjectTemplate[]> {
  if (deps.platform === "web") return [];

  const { templatesFolder } = await deps.loadSettings();
  if (!templatesFolder) return [];

  try {
    return await listTemplates(await deps.openTemplatesFolder(templatesFolder));
  } catch {
    return [];
  }
}

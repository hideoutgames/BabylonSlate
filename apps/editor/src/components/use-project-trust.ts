import { useCallback } from "react";
import { useAppSettings } from "../context/app-settings-context";
import { useRegistryState } from "../context/document-context";

/** Most recently trusted projects kept; older trust lapses and is asked for again. */
const MAX_TRUSTED_PROJECTS = 500;

/**
 * Workspace Trust for the open project (its Extensions and Editor Utilities), kept in this
 * computer's Engine Settings under the project's folder and GUID. A project
 * this editor created in this session is trusted without asking.
 */
export function useProjectTrust(): {
  /** False until Engine Settings have loaded and a project is open. */
  ready: boolean;
  trusted: boolean;
  /** Whether Engine Settings record the trust (a project created here is trusted before they do). */
  persisted: boolean;
  setTrusted: (trusted: boolean) => Promise<void>;
} {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const { extensionService, projectGuid } = useRegistryState();
  const key = extensionService && projectGuid ? extensionService.projectTrustKey(projectGuid) : null;
  const stored = key !== null && settings.trustedProjects.includes(key);
  const trusted = stored || (key !== null && extensionService!.createdHere(key));
  const setTrusted = useCallback(async (next: boolean) => {
    if (key === null) return;
    if (!next) extensionService?.forgetCreatedProject();
    await updateSettings((current) => {
      const others = current.trustedProjects.filter((value) => value !== key);
      current.trustedProjects = next ? [...others, key].slice(-MAX_TRUSTED_PROJECTS) : others;
    });
  }, [extensionService, key, updateSettings]);
  return { ready: hydrated && key !== null, trusted, persisted: stored, setTrusted };
}

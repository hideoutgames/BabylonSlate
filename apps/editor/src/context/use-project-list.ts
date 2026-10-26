import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectFolderHandle, ProjectMetadata } from "@haptic/core";
import type { ProjectTemplateCatalogEntry } from "@haptic/assets";
import { getHostPlatform, type createAppSettingsStore } from "@haptic/vfs";
import {
  listedProjectsFromRecents,
  recentProjectsWithOpenedProject,
  shouldDeleteOpfsOnRemove,
  type ListedProject,
  type UpdateListedProjectOptions,
} from "../lib/listed-projects";
import type { ProjectService } from "../services/project-service";
import { loadTemplateCards } from "../services/template-service";
import type { AppRoute, DocumentActions } from "./document-context-types";
import { useRefState } from "./use-ref-state";

export interface ProjectListDeps {
  projectService: ProjectService;
  settingsStore: ReturnType<typeof createAppSettingsStore>;
  /** Homepage refreshes the list whenever the app comes back to the foreground. */
  route: AppRoute;
}

/**
 * Homepage's project list and templates, and the recent projects in app
 * settings behind the list. Every callback keeps its identity for the
 * provider's lifetime.
 */
export function useProjectList({
  projectService,
  settingsStore,
  route,
}: ProjectListDeps) {
  const [listedProjects, setListedProjects] = useState<ListedProject[]>([]);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [homepageReady, setHomepageReady] = useState(false);
  const templatesRef = useRef<ProjectTemplateCatalogEntry[]>([]);
  const [templates, setTemplates] = useRefState(templatesRef);

  const recordRecent = useCallback(
    async (
      handle: ProjectFolderHandle | null,
      metadata: ProjectMetadata,
      sourceControl: boolean,
    ) => {
      if (!handle) return;
      await settingsStore.update((settings) => {
        settings.recents = recentProjectsWithOpenedProject(
          settings.recents,
          handle,
          metadata,
          new Date().toISOString(),
          sourceControl,
        );
      });
    },
    [settingsStore],
  );

  const refreshProjectList = useCallback(async () => {
    const fromStorage = await projectService.listProjects();
    const settings = await settingsStore.load();
    setListedProjects(
      listedProjectsFromRecents(settings.recents, fromStorage),
    );
    setNeedsReconnect(await projectService.needsReconnect());
  }, [projectService, settingsStore]);

  // Projects can be deleted outside the editor (e.g. in Files on iPad) while it is in the background.
  useEffect(() => {
    if (route !== "home") return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshProjectList().catch((error: unknown) => console.warn("[editor] could not refresh the project list", error));
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [route, refreshProjectList]);

  const refreshTemplates = useCallback(async () => {
    setTemplates(await loadTemplateCards());
  }, [setTemplates]);

  const updateListedProject = useCallback(
    async (handle: ProjectFolderHandle, details: UpdateListedProjectOptions) => {
      const trimmed = details.name.trim();
      if (!trimmed) return;
      await projectService.updateListedProject(handle, {
        ...details,
        name: trimmed,
      });
      await settingsStore.update((settings) => {
        settings.recents = settings.recents.map((recent) =>
          recent.id === handle.id
            ? {
                ...recent,
                name: trimmed,
                ...(details.appearance ? { appearance: details.appearance } : {}),
              }
            : recent,
        );
      });
      await refreshProjectList();
    },
    [projectService, refreshProjectList, settingsStore],
  );

  const removeListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      if (shouldDeleteOpfsOnRemove(getHostPlatform(), handle.tier)) {
        await projectService.deleteListedProject(handle);
      }
      await settingsStore.update((settings) => {
        settings.recents = settings.recents.filter(
          (recent) => recent.id !== handle.id,
        );
      });
      await refreshProjectList();
    },
    [projectService, refreshProjectList, settingsStore],
  );

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "refreshTemplates"
      | "updateListedProject"
      | "removeListedProject"
    > => ({
      refreshTemplates,
      updateListedProject,
      removeListedProject,
    }),
    [
      refreshTemplates,
      updateListedProject,
      removeListedProject,
    ],
  );

  return {
    listedProjects,
    needsReconnect,
    setNeedsReconnect,
    homepageReady,
    setHomepageReady,
    templates,
    templatesRef,
    recordRecent,
    refreshProjectList,
    refreshTemplates,
    actions,
  };
}

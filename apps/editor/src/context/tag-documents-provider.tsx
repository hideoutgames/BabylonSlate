import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { createTag, normalizeTagRegistry } from "@babylonslate/core";
import { TagProvider } from "@babylonslate/editor-kit";
import { useDocuments } from "./document-context";

const EMPTY_TAGS = normalizeTagRegistry(undefined);

/** Keeps every Tag picker on the active project's saved registry. */
export function TagDocumentsProvider({ children }: { children: ReactNode }) {
  const { projectDocument, projectGuid, updateProjectSettings } = useDocuments();
  const registry = projectDocument?.settings.tags ?? EMPTY_TAGS;
  const latest = useRef({ registry, projectGuid, hasProject: Boolean(projectDocument) });
  useLayoutEffect(() => {
    latest.current = { registry, projectGuid, hasProject: Boolean(projectDocument) };
  }, [registry, projectGuid, projectDocument]);

  const onCreate = useCallback((path: string) => {
    if (latest.current.projectGuid !== projectGuid) throw new Error("The active project changed. Open the Tag picker again.");
    if (!latest.current.hasProject) throw new Error("Open a project to create Tags.");
    const created = createTag(latest.current.registry, path);
    // Consecutive creates share the new allocation even before React renders.
    latest.current.registry = created.registry;
    updateProjectSettings({ tags: created.registry });
    return created.tag;
  }, [projectGuid, updateProjectSettings]);

  return (
    <TagProvider entries={registry.tags} onCreate={projectDocument ? onCreate : undefined}>
      {children}
    </TagProvider>
  );
}

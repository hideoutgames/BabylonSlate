import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  identitySerializedTransform,
  patchComponentProperties,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedTransform,
} from "@babylonslate/core";
import type { TreeDropPlacement } from "@babylonslate/editor-kit";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import {
  applyPrefabComponentTransform,
  applyPrefabPivotDelta,
  componentSubtreeIds,
  mergePrefabComponents,
  nextPrefabComponentId,
  prefabComponentsFromGraph,
  PREFAB_ROOT_ID,
  reparentPrefabComponents,
  type PrefabComponentView,
} from "../lib/prefab-preview";
import { defaultPropertiesFor } from "../panels/add-component-catalog";
import { classParentLookup } from "../lib/content-browser-helpers";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";

interface PrefabEditingContextValue {
  components: PrefabComponentView[];
  selectedId: string | null;
  selectedIds: string[];
  setSelectedId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  addComponent: (classId: string) => void;
  removeSelected: () => void;
  reparentComponent: (
    dragId: string,
    targetId: string | null,
    placement?: TreeDropPlacement,
  ) => void;
  updateComponent: (
    componentId: string,
    property: string,
    value: unknown,
  ) => void;
  updateComponentTransform: (
    componentId: string,
    transform: SerializedTransform,
  ) => void;
  applyPivotTransform: (transform: SerializedTransform) => void;
}

const PrefabEditingContext = createContext<PrefabEditingContextValue | null>(
  null,
);

function stripInheritance(
  components: readonly PrefabComponentView[],
): SerializedComponent[] {
  return components.map((component) => {
    const { inheritedFrom: _ignored, ...rest } = component;
    void _ignored;
    return {
      id: rest.id,
      classId: rest.classId,
      properties: { ...rest.properties },
      parentId: rest.parentId ?? null,
      ...(rest.transform ? { transform: rest.transform } : {}),
    };
  });
}

export function PrefabEditingProvider({
  children,
  initialSelectedId = PREFAB_ROOT_ID,
  initialSelectedIds,
}: {
  children: ReactNode;
  initialSelectedId?: string | null;
  initialSelectedIds?: readonly string[];
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange, assetRegistry } = useDocuments();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (initialSelectedIds && initialSelectedIds.length > 0) {
      return [...initialSelectedIds];
    }
    return initialSelectedId ? [initialSelectedId] : [];
  });
  const selectedId = selectedIds[selectedIds.length - 1] ?? null;
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
  }, []);

  const graph = useMemo(() => {
    const doc = openDocuments.find((entry) => entry.id === documentId);
    if (doc?.ref.kind !== "graph" || !doc.content) return null;
    return doc.content as SerializedGraph;
  }, [documentId, openDocuments]);

  const classId = useMemo(() => {
    const doc = openDocuments.find((entry) => entry.id === documentId);
    return doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;
  }, [documentId, openDocuments]);

  const parentOf = useMemo(
    () => classParentLookup(assetRegistry?.list() ?? []),
    [assetRegistry],
  );

  const parentGraphs = useMemo(
    () =>
      collectClassGraphsForPalette({
        assets: assetRegistry?.list() ?? [],
        openDocuments,
        classIdForPath: classIdForGraphPath,
      }),
    [assetRegistry, openDocuments],
  );

  const localComponents = useMemo(
    () => prefabComponentsFromGraph(graph),
    [graph],
  );

  const components = useMemo(() => {
    const ancestors: Array<{
      classId: string;
      components: SerializedComponent[];
    }> = [];
    const seen = new Set<string>();
    let current = classId ? parentOf(classId) : null;
    const chain: string[] = [];
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = parentOf(current);
    }
    // Root-first for merge.
    for (const id of [...chain].reverse()) {
      const parentGraph = parentGraphs[id];
      if (!parentGraph?.components?.length) continue;
      ancestors.push({ classId: id, components: parentGraph.components });
    }
    // When local is still the default singleton and parents contribute, prefer merge.
    const local =
      graph && Array.isArray(graph.components)
        ? graph.components
        : ancestors.length > 0
          ? []
          : localComponents;
    return mergePrefabComponents(ancestors, local);
  }, [classId, graph, localComponents, parentGraphs, parentOf]);

  const persistLocal = useCallback(
    (nextLocal: SerializedComponent[]) => {
      if (!graph) return;
      void applyGraphChange(documentId, { ...graph, components: nextLocal });
    },
    [applyGraphChange, documentId, graph],
  );

  const upsertLocalFromViews = useCallback(
    (views: PrefabComponentView[]) => {
      // Persist owned components and inherited overrides (full merged snapshot
      // minus pure-parent-only rows that were never touched stays via merge).
      // Store every view so child documents round-trip transforms for inherited.
      persistLocal(stripInheritance(views));
    },
    [persistLocal],
  );

  const addComponent = useCallback(
    (classIdToAdd: string) => {
      const next: PrefabComponentView[] = [
        ...components,
        {
          id: nextPrefabComponentId(components),
          classId: classIdToAdd,
          properties: defaultPropertiesFor(classIdToAdd),
          parentId: null,
          transform: identitySerializedTransform(),
        },
      ];
      upsertLocalFromViews(next);
    },
    [components, upsertLocalFromViews],
  );

  const removeSelected = useCallback(() => {
    const doomed = new Set<string>();
    for (const id of selectedIds) {
      if (id === PREFAB_ROOT_ID) continue;
      const selected = components.find((component) => component.id === id);
      if (selected?.inheritedFrom) continue;
      const subtree = componentSubtreeIds(components, id);
      if (
        components.some(
          (component) => subtree.has(component.id) && component.inheritedFrom,
        )
      ) {
        continue;
      }
      for (const doomedId of subtree) doomed.add(doomedId);
    }
    if (doomed.size === 0) return;
    upsertLocalFromViews(
      components.filter((component) => !doomed.has(component.id)),
    );
    setSelectedIds([PREFAB_ROOT_ID]);
  }, [components, selectedIds, upsertLocalFromViews]);

  const reparentComponent = useCallback(
    (
      dragId: string,
      targetId: string | null,
      placement?: TreeDropPlacement,
    ) => {
      upsertLocalFromViews(
        reparentPrefabComponents(
          components,
          dragId,
          targetId,
          selectedIds,
          placement,
        ),
      );
    },
    [components, selectedIds, upsertLocalFromViews],
  );

  const updateComponent = useCallback(
    (componentId: string, property: string, value: unknown) => {
      upsertLocalFromViews(
        components.map((component) =>
          component.id === componentId
            ? {
                ...component,
                properties: patchComponentProperties(
                  component.properties,
                  property,
                  value,
                ),
              }
            : component,
        ),
      );
    },
    [components, upsertLocalFromViews],
  );

  const updateComponentTransform = useCallback(
    (componentId: string, transform: SerializedTransform) => {
      upsertLocalFromViews(
        applyPrefabComponentTransform(components, componentId, transform),
      );
    },
    [components, upsertLocalFromViews],
  );

  const applyPivotTransform = useCallback(
    (transform: SerializedTransform) => {
      upsertLocalFromViews(applyPrefabPivotDelta(components, transform));
    },
    [components, upsertLocalFromViews],
  );

  const value = useMemo(
    () => ({
      components,
      selectedId,
      selectedIds,
      setSelectedId,
      setSelectedIds,
      addComponent,
      removeSelected,
      reparentComponent,
      updateComponent,
      updateComponentTransform,
      applyPivotTransform,
    }),
    [
      addComponent,
      applyPivotTransform,
      components,
      removeSelected,
      reparentComponent,
      selectedId,
      selectedIds,
      setSelectedId,
      updateComponent,
      updateComponentTransform,
    ],
  );

  return (
    <PrefabEditingContext.Provider value={value}>
      {children}
    </PrefabEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function usePrefabEditing(): PrefabEditingContextValue {
  const context = useContext(PrefabEditingContext);
  if (!context) {
    throw new Error(
      "usePrefabEditing must be used within PrefabEditingProvider",
    );
  }
  return context;
}

export function useOptionalPrefabEditing(): PrefabEditingContextValue | null {
  return useContext(PrefabEditingContext);
}

export { previewSceneFor } from "../lib/prefab-preview";
/* eslint-enable react-refresh/only-export-components */

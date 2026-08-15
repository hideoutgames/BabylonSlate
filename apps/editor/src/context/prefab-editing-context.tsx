import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SerializedComponent, SerializedGraph } from "@babylonslate/core";
import { identitySerializedTransform } from "@babylonslate/core";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import {
  componentSubtreeIds,
  nextPrefabComponentId,
  prefabComponentsFromGraph,
  PREFAB_ROOT_ID,
  reparentPrefabComponents,
} from "../lib/prefab-preview";
import { defaultPropertiesFor } from "../panels/add-component-catalog";

interface PrefabEditingContextValue {
  components: SerializedComponent[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  addComponent: (classId: string) => void;
  removeSelected: () => void;
  reparentComponent: (dragId: string, targetId: string | null) => void;
  updateComponent: (
    componentId: string,
    property: string,
    value: unknown,
  ) => void;
}

const PrefabEditingContext = createContext<PrefabEditingContextValue | null>(
  null,
);

export function PrefabEditingProvider({
  children,
  initialSelectedId = PREFAB_ROOT_ID,
}: {
  children: ReactNode;
  initialSelectedId?: string | null;
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );

  const graph = useMemo(() => {
    const doc = openDocuments.find((entry) => entry.id === documentId);
    if (doc?.ref.kind !== "graph" || !doc.content) return null;
    return doc.content as SerializedGraph;
  }, [documentId, openDocuments]);

  const components = prefabComponentsFromGraph(graph);

  const persist = useCallback(
    (next: SerializedComponent[]) => {
      if (!graph) return;
      void applyGraphChange(documentId, { ...graph, components: next });
    },
    [applyGraphChange, documentId, graph],
  );

  const addComponent = useCallback(
    (classId: string) => {
      persist([
        ...components,
        {
          id: nextPrefabComponentId(components),
          classId,
          properties: defaultPropertiesFor(classId),
          parentId: null,
          transform: identitySerializedTransform(),
        },
      ]);
    },
    [components, persist],
  );

  const removeSelected = useCallback(() => {
    if (!selectedId || selectedId === PREFAB_ROOT_ID) return;
    const doomed = componentSubtreeIds(components, selectedId);
    persist(components.filter((component) => !doomed.has(component.id)));
    setSelectedId(PREFAB_ROOT_ID);
  }, [components, persist, selectedId]);

  const reparentComponent = useCallback(
    (dragId: string, targetId: string | null) => {
      persist(reparentPrefabComponents(components, dragId, targetId));
    },
    [components, persist],
  );

  const updateComponent = useCallback(
    (componentId: string, property: string, value: unknown) => {
      persist(
        components.map((component) =>
          component.id === componentId
            ? {
                ...component,
                properties: { ...component.properties, [property]: value },
              }
            : component,
        ),
      );
    },
    [components, persist],
  );

  const value = useMemo(
    () => ({
      components,
      selectedId,
      setSelectedId,
      addComponent,
      removeSelected,
      reparentComponent,
      updateComponent,
    }),
    [
      addComponent,
      components,
      removeSelected,
      reparentComponent,
      selectedId,
      updateComponent,
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

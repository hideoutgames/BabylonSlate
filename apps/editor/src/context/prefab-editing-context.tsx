import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SerializedComponent } from "@babylonslate/core";
import {
  defaultPrefabComponents,
  previewSceneFor,
} from "../lib/prefab-preview";
import { defaultPropertiesFor } from "../panels/add-component-catalog";

interface PrefabEditingContextValue {
  components: SerializedComponent[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  addComponent: (classId: string) => void;
  removeSelected: () => void;
}

const PrefabEditingContext = createContext<PrefabEditingContextValue | null>(
  null,
);

export function PrefabEditingProvider({ children }: { children: ReactNode }) {
  const [components, setComponents] = useState<SerializedComponent[]>(
    defaultPrefabComponents,
  );
  const [selectedId, setSelectedId] = useState<string | null>("prefab-mesh");

  const addComponent = useCallback((classId: string) => {
    setComponents((current) => [
      ...current,
      {
        id: `prefab-component-${current.length + 1}`,
        classId,
        properties: defaultPropertiesFor(classId),
      },
    ]);
  }, []);

  const removeSelected = useCallback(() => {
    setComponents((current) => {
      if (!selectedId || selectedId === "prefab-root") return current;
      return current.filter((component) => component.id !== selectedId);
    });
    setSelectedId("prefab-root");
  }, [selectedId]);

  const value = useMemo(
    () => ({
      components,
      selectedId,
      setSelectedId,
      addComponent,
      removeSelected,
    }),
    [addComponent, components, removeSelected, selectedId],
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
    throw new Error("usePrefabEditing must be used within PrefabEditingProvider");
  }
  return context;
}

export { previewSceneFor };
/* eslint-enable react-refresh/only-export-components */

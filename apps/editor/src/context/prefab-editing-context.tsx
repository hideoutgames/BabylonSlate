import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { IndexedAsset } from "@babylonslate/assets";
import type { OpenDocument } from "../services/document-service";
import {
  identitySerializedTransform,
  setSceneStreamingTarget,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedTransform,
} from "@babylonslate/core";
import type { TreeDropPlacement } from "@babylonslate/editor-kit";
import { patchInspectorComponentProperty } from "../lib/mesh-material-properties";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useOptionalSceneEditing } from "./scene-editing-context";
import {
  applyPrefabComponentTransform,
  authoredTransformFromPreview,
  applyPrefabPivotDelta,
  componentSubtreeIds,
  mergePrefabComponents,
  nextPrefabComponentId,
  prefabComponentsFromGraph,
  PREFAB_ROOT_ID,
  reparentPrefabComponents,
  type PrefabComponentView,
} from "../lib/prefab-preview";
import {
  defaultPropertiesFor,
  physicsWorldFromOpenDocuments,
  type AddComponentSelection,
} from "../panels/add-component-catalog";
import { classParentLookup } from "../lib/content-browser-helpers";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";

interface PrefabEditingContextValue {
  components: PrefabComponentView[];
  selectedId: string | null;
  selectedIds: string[];
  setSelectedId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  addComponent: (selection: AddComponentSelection) => void;
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
  commitComponentProperties: (
    componentId: string,
    properties: Record<string, unknown>,
  ) => void;
  commitComponentGizmo: (
    componentId: string,
    transform: SerializedTransform,
    properties?: Record<string, unknown>,
  ) => void;
  commitComponentTransforms: (
    changes: readonly {
      componentId: string;
      transform: SerializedTransform;
    }[],
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

type PrefabAncestor = {
  classId: string;
  components: readonly SerializedComponent[];
};

const NO_ASSETS: readonly IndexedAsset[] = [];
const NO_ANCESTORS: readonly PrefabAncestor[] = [];

/** Changes whenever a Class asset is added, removed, renamed or reparented. */
function classParentSignature(assets: readonly IndexedAsset[]): string {
  let signature = "";
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    signature += `${asset.path}\u0000${asset.header.name}\u0000${asset.header.parentClass ?? ""}\n`;
  }
  return signature;
}

/**
 * Ancestor classes (root first) that contribute prefab components. Only the
 * ancestor chain's assets and open documents are read, with the same lookup
 * and open-document precedence as the Class palette.
 */
function prefabAncestors(
  classId: string | null,
  parentOf: (id: string) => string | null,
  assets: readonly IndexedAsset[],
  openDocuments: readonly OpenDocument[],
): readonly PrefabAncestor[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = classId ? parentOf(classId) : null;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf(current);
  }
  if (chain.length === 0) return NO_ANCESTORS;
  const graphs = collectClassGraphsForPalette({
    assets: assets.filter(
      (asset) =>
        seen.has(asset.header.name) || seen.has(classIdForGraphPath(asset.path)),
    ),
    openDocuments: openDocuments.filter(
      (entry) =>
        entry.ref.kind === "graph" && seen.has(classIdForGraphPath(entry.ref.path)),
    ),
    classIdForPath: classIdForGraphPath,
  });
  const ancestors: PrefabAncestor[] = [];
  for (const id of chain.reverse()) {
    const components = graphs[id]?.components;
    if (components?.length) ancestors.push({ classId: id, components });
  }
  return ancestors.length > 0 ? ancestors : NO_ANCESTORS;
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
  const viewportMode = useOptionalSceneEditing()?.viewportMode ?? "3d";
  // Read when a component is added, not on every document change.
  const openDocumentsRef = useRef(openDocuments);
  openDocumentsRef.current = openDocuments;
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

  const doc = openDocuments.find((entry) => entry.id === documentId);
  // Only Class documents have prefab components; Scene and Scene Layer
  // workspaces skip the registry walk entirely.
  const graph =
    doc?.ref.kind === "graph" && doc.content
      ? (doc.content as SerializedGraph)
      : null;
  const classId = graph && doc ? classIdForGraphPath(doc.ref.path) : null;
  const assets = graph ? (assetRegistry?.list() ?? NO_ASSETS) : NO_ASSETS;

  // Keyed by the class parents, not the registry instance: a reparent updates
  // the registry header in place.
  const parentSignature = classParentSignature(assets);
  const parentOf = useMemo(
    () => classParentLookup(assets),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parentSignature is the input that matters
    [parentSignature],
  );

  const ancestorsRef = useRef<readonly PrefabAncestor[]>(NO_ANCESTORS);
  const latestAncestors = prefabAncestors(
    classId,
    parentOf,
    assets,
    openDocuments,
  );
  // Header payloads parse into fresh arrays; keep the previous list while the
  // inherited components are unchanged so the published value stays stable.
  if (JSON.stringify(latestAncestors) !== JSON.stringify(ancestorsRef.current)) {
    ancestorsRef.current = latestAncestors;
  }
  const ancestors = ancestorsRef.current;

  const localComponents = useMemo(
    () => prefabComponentsFromGraph(graph),
    [graph],
  );

  const components = useMemo(() => {
    // When local is still the default singleton and parents contribute, prefer merge.
    const local =
      graph && Array.isArray(graph.components)
        ? graph.components
        : ancestors.length > 0
          ? []
          : localComponents;
    return mergePrefabComponents(ancestors, local);
  }, [ancestors, graph, localComponents]);

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
    (selection: AddComponentSelection) => {
      const id = nextPrefabComponentId(components);
      const selectedComponent =
        selectedId && selectedId !== PREFAB_ROOT_ID
          ? components.find((component) => component.id === selectedId)
          : undefined;
      const next: PrefabComponentView[] = [
        ...components,
        {
          id,
          classId: selection.classId,
          properties: {
            ...defaultPropertiesFor(
              selection.classId,
              physicsWorldFromOpenDocuments(openDocumentsRef.current),
              viewportMode,
            ),
            ...selection.properties,
          },
          parentId: selectedComponent ? selectedComponent.id : null,
          transform: identitySerializedTransform(),
        },
      ];
      upsertLocalFromViews(next);
      setSelectedIds([id]);
    },
    [components, selectedId, upsertLocalFromViews, viewportMode],
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
      if (property === "sceneGuid" && components.some((component) => component.id === componentId && component.classId === "SceneStreamingComponent")) {
        const guid = typeof value === "string" ? value : null;
        upsertLocalFromViews(setSceneStreamingTarget(components, componentId, guid, guid ? assetRegistry?.getByGuid(guid)?.header.name ?? "" : ""));
        return;
      }
      upsertLocalFromViews(
        components.map((component) =>
          component.id === componentId
            ? {
                ...component,
                properties: patchInspectorComponentProperty(
                  component,
                  property,
                  value,
                ),
              }
            : component,
        ),
      );
    },
    [assetRegistry, components, upsertLocalFromViews],
  );

  const updateComponentTransform = useCallback(
    (componentId: string, transform: SerializedTransform) => {
      upsertLocalFromViews(
        applyPrefabComponentTransform(components, componentId, transform),
      );
    },
    [components, upsertLocalFromViews],
  );

  const commitComponentProperties = useCallback(
    (componentId: string, properties: Record<string, unknown>) => {
      if (!components.some((component) => component.id === componentId)) return;
      upsertLocalFromViews(components.map((component) =>
        component.id === componentId
          ? { ...component, properties: { ...component.properties, ...properties } }
          : component,
      ));
    },
    [components, upsertLocalFromViews],
  );

  const commitComponentGizmo = useCallback(
    (
      componentId: string,
      transform: SerializedTransform,
      properties?: Record<string, unknown>,
    ) => {
      const withProps = properties
        ? components.map((component) =>
            component.id === componentId
              ? {
                  ...component,
                  properties: { ...component.properties, ...properties },
                }
              : component,
          )
        : components;
      upsertLocalFromViews(
        applyPrefabComponentTransform(
          withProps,
          componentId,
          authoredTransformFromPreview(withProps, componentId, transform),
        ),
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

  const commitComponentTransforms = useCallback(
    (
      changes: readonly {
        componentId: string;
        transform: SerializedTransform;
      }[],
    ) => {
      const transforms = new Map(
        changes
          .filter((change) => change.componentId !== PREFAB_ROOT_ID)
          .map((change) => [change.componentId, change.transform]),
      );
      if (!components.some((component) => transforms.has(component.id))) return;
      upsertLocalFromViews(
        components.map((component) => {
          const transform = transforms.get(component.id);
          return transform
            ? {
                ...component,
                transform: {
                  position: [...transform.position],
                  rotation: [...transform.rotation],
                  scale: [...transform.scale],
                },
              }
            : component;
        }),
      );
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
      commitComponentProperties,
      commitComponentGizmo,
      commitComponentTransforms,
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
      commitComponentProperties,
      commitComponentGizmo,
      commitComponentTransforms,
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

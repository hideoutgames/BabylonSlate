import { CONTENT_BROWSER_ID, isAssetDocumentKind, type SerializedScene } from "@babylonslate/core";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { useProjectSearch } from "../context/project-search-context";
import {
  SceneEditingProvider,
  useSceneEditing,
} from "../context/scene-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { TypeAssetEditingProvider } from "../context/type-asset-editing-context";
import { sceneFocusActorId } from "../lib/search-navigation";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { AssetDocumentWorkspace } from "./asset-document-workspace";
import { DockviewShell } from "../shell/dockview-shell";
import {
  classDocumentShowsPrefab,
  classParentLookup,
} from "../lib/content-browser-helpers";
import {
  isDockviewDocumentKind,
  type DockviewDocumentKind,
} from "../shell/window-catalog";

function PendingSceneSearchFocus({ scenePath }: { scenePath: string }) {
  const { pendingTarget, clearPendingTarget } = useProjectSearch();
  const { selectActor } = useSceneEditing();

  useEffect(() => {
    const actorId = pendingTarget ? sceneFocusActorId(pendingTarget) : null;
    if (!pendingTarget || !actorId) return;
    if (
      pendingTarget.kind !== "scene-actor" &&
      pendingTarget.kind !== "scene-component"
    ) {
      return;
    }
    if (pendingTarget.scenePath !== scenePath) return;
    selectActor(actorId);
    clearPendingTarget();
  }, [clearPendingTarget, pendingTarget, scenePath, selectActor]);

  return null;
}

function RegisteredDockviewShell({
  id,
  documentKind,
  initialLayout,
  actorPrefab,
}: {
  id: string;
  documentKind: DockviewDocumentKind;
  initialLayout: Record<string, unknown> | null;
  actorPrefab?: boolean;
}) {
  const { registerDockviewApi } = useDocuments();
  const onReady = useCallback(
    (api: DockviewApi) => {
      registerDockviewApi(id, api);
    },
    [id, registerDockviewApi],
  );

  return (
    <DockviewShell
      documentKind={documentKind}
      initialLayout={initialLayout}
      actorPrefab={actorPrefab}
      onReady={onReady}
    />
  );
}

export function DocumentWorkspace() {
  const {
    tabOrder,
    activeDocumentId,
    openDocuments,
    projectDocument,
    assetRegistry,
  } = useDocuments();

  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());

  const projectKey = projectDocument?.metadata.name ?? null;

  useEffect(() => {
    if (projectKey) {
      setMountedIds(new Set([CONTENT_BROWSER_ID]));
    } else {
      setMountedIds(new Set());
    }
  }, [projectKey]);

  const resolvedActiveId =
    tabOrder.length === 0
      ? null
      : activeDocumentId && tabOrder.includes(activeDocumentId)
        ? activeDocumentId
        : (tabOrder.find((id) => id === CONTENT_BROWSER_ID) ?? tabOrder[0]);

  useEffect(() => {
    if (!resolvedActiveId) return;
    setMountedIds((prev) => {
      if (prev.has(resolvedActiveId)) return prev;
      const next = new Set(prev);
      next.add(resolvedActiveId);
      return next;
    });
  }, [resolvedActiveId]);

  if (tabOrder.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to begin
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabOrder.map((id) => {
        const doc = openDocuments.find((entry) => entry.id === id);
        if (!doc) return null;
        const active = id === resolvedActiveId;
        const shouldMount =
          mountedIds.has(id) ||
          (doc.ref.kind === "content-browser" && active);

        if (doc.ref.kind === "content-browser") {
          if (!shouldMount) return null;
          return (
            <div
              key={id}
              className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              data-testid="document-workspace-content-browser"
            >
              <ContentBrowserWorkspace />
            </div>
          );
        }

        if (
          isAssetDocumentKind(doc.ref.kind) &&
          !isDockviewDocumentKind(doc.ref.kind)
        ) {
          if (!shouldMount) return null;
          return (
            <div
              key={id}
              className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              data-testid={`document-workspace-${doc.ref.kind}`}
            >
              <AssetDocumentWorkspace documentId={id} />
            </div>
          );
        }

        const isTypeAsset =
          doc.ref.kind === "enum" ||
          doc.ref.kind === "structure" ||
          doc.ref.kind === "script-interface";

        if (doc.ref.kind === "sprite") {
          if (!shouldMount) return null;
          return (
            <DocumentWorkspaceProvider key={id} documentId={id}>
              <div
                className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                data-testid="document-workspace-sprite"
              >
                <RegisteredDockviewShell
                  id={id}
                  documentKind="sprite"
                  initialLayout={doc.layout}
                />
              </div>
            </DocumentWorkspaceProvider>
          );
        }

        if (isTypeAsset) {
          if (!shouldMount) return null;
          return (
            <DocumentWorkspaceProvider key={id} documentId={id}>
              <TypeAssetEditingProvider>
                <div
                  className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                  data-testid={`document-workspace-${doc.ref.kind}`}
                >
                  <RegisteredDockviewShell
                    id={id}
                    documentKind={doc.ref.kind}
                    initialLayout={doc.layout}
                  />
                </div>
              </TypeAssetEditingProvider>
            </DocumentWorkspaceProvider>
          );
        }

        const sceneContent =
          doc.ref.kind === "scene"
            ? (doc.content as SerializedScene | null)
            : null;
        const parentOf = classParentLookup(assetRegistry?.list() ?? []);
        const indexed = assetRegistry
          ?.list()
          .find((asset) => asset.path === doc.ref.path);
        const actorPrefab =
          doc.ref.kind !== "graph" ||
          !indexed ||
          classDocumentShowsPrefab(indexed.header.parentClass, parentOf, {
            assetType: indexed.header.type,
          });

        return (
          <DocumentWorkspaceProvider key={id} documentId={id}>
            <SceneEditingProvider
              initialViewportMode={sceneContent?.viewportMode ?? "3d"}
              documentViewportMode={sceneContent?.viewportMode}
              documentSnapEnabled={sceneContent?.settings.grid.snapEnabled}
              documentJoystickEnabled={
                sceneContent?.settings.editorJoystickEnabled
              }
              documentGridVisible={sceneContent?.settings.grid.showGrid}
            >
              <PrefabEditingProvider>
              <GraphEditingProvider>
              {doc.ref.kind === "scene" ? (
                <PendingSceneSearchFocus scenePath={doc.ref.path} />
              ) : null}
              <div
                className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                data-testid={`document-workspace-${doc.ref.kind}`}
              >
                {shouldMount ? (
                  <RegisteredDockviewShell
                    id={id}
                    documentKind={
                      doc.ref.kind === "scene" ? "scene" : "graph"
                    }
                    initialLayout={doc.layout}
                    actorPrefab={actorPrefab}
                  />
                ) : null}
              </div>
              </GraphEditingProvider>
              </PrefabEditingProvider>
            </SceneEditingProvider>
          </DocumentWorkspaceProvider>
        );
      })}
    </div>
  );
}

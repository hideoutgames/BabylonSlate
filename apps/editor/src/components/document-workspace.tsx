import { CONTENT_BROWSER_ID, isAssetDocumentKind, type SerializedScene } from "@babylonslate/core";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { UiEditingProvider } from "../context/ui-editing-context";
import { useProjectSearch } from "../context/project-search-context";
import {
  SceneEditingProvider,
  useSceneEditing,
} from "../context/scene-editing-context";
import { NavBakeProvider } from "../context/nav-bake-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { TypeAssetEditingProvider } from "../context/type-asset-editing-context";
import { sceneFocusActorId } from "../lib/search-navigation";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { AssetDocumentWorkspace } from "./asset-document-workspace";
import { DocumentLockBanner } from "./document-lock-banner";
import { WorkspaceErrorBoundary } from "./workspace-error-boundary";
import { DockviewShell } from "../shell/dockview-shell";
import {
  classDocumentShowsPrefab,
  classParentLookup,
} from "../lib/content-browser-helpers";
import {
  isDockviewDocumentKind,
  type DockviewDocumentKind,
} from "../shell/window-catalog";
import { UiEditorModeBar } from "./ui-editor-mode-bar";
import { parseUiDocumentLayout } from "../shell/ui-document-layout";
import { cn } from "@babylonslate/ui/lib/utils";

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
  editorUtilityInterface,
  uiEditorMode,
  surface,
}: {
  id: string;
  documentKind: DockviewDocumentKind;
  initialLayout: Record<string, unknown> | null;
  actorPrefab?: boolean;
  editorUtilityInterface?: boolean;
  uiEditorMode?: import("../shell/ui-document-layout").UiEditorMode;
  surface?: import("../shell/dockview-surface").DockviewSurface;
}) {
  const { registerDockviewApi, sourceControl } = useDocuments();
  const onReady = useCallback(
    (api: DockviewApi) => {
      registerDockviewApi(id, api, surface);
    },
    [id, registerDockviewApi, surface],
  );

  return (
    <DockviewShell
      documentKind={documentKind}
      initialLayout={initialLayout}
      actorPrefab={actorPrefab}
      editorUtilityInterface={editorUtilityInterface}
      sourceControl={sourceControl.enabled}
      uiEditorMode={uiEditorMode}
      onReady={onReady}
    />
  );
}

function DocumentShell({
  path,
  testId,
  active,
  children,
}: {
  path: string;
  testId: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const { sourceControl } = useDocuments();
  return (
    <div
      className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      data-testid={testId}
    >
      <DocumentLockBanner path={path} sourceControl={sourceControl} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function UiDocumentDocks({
  id,
  layout,
  editorUtilityInterface,
}: {
  id: string;
  layout: Record<string, unknown> | null;
  editorUtilityInterface: boolean;
}) {
  const { uiEditorMode, setUiEditorMode, activeDocumentId } = useDocuments();
  const parsed = parseUiDocumentLayout(layout);
  const mode = activeDocumentId === id ? uiEditorMode : parsed.uiEditorMode;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <UiEditorModeBar
        mode={mode}
        onModeChange={(next) => setUiEditorMode(id, next)}
      />
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0",
            mode !== "designer" && "ui-dock-surface-inactive",
          )}
          aria-hidden={mode !== "designer"}
          data-testid="ui-dock-surface-designer"
          data-active={mode === "designer" ? "true" : "false"}
        >
          <RegisteredDockviewShell
            id={id}
            documentKind="ui"
            initialLayout={parsed.designer}
            editorUtilityInterface={editorUtilityInterface}
            uiEditorMode="designer"
            surface="designer"
          />
        </div>
        <div
          className={cn(
            "absolute inset-0",
            mode !== "logic" && "ui-dock-surface-inactive",
          )}
          aria-hidden={mode !== "logic"}
          data-testid="ui-dock-surface-logic"
          data-active={mode === "logic" ? "true" : "false"}
        >
          <RegisteredDockviewShell
            id={id}
            documentKind="ui"
            initialLayout={parsed.logic}
            actorPrefab={false}
            uiEditorMode="logic"
            surface="logic"
          />
        </div>
      </div>
    </div>
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
            <WorkspaceErrorBoundary key={id}>
              <div
                className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                data-testid="document-workspace-content-browser"
              >
                <ContentBrowserWorkspace />
              </div>
            </WorkspaceErrorBoundary>
          );
        }

        if (
          isAssetDocumentKind(doc.ref.kind) &&
          !isDockviewDocumentKind(doc.ref.kind)
        ) {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentShell
                path={doc.ref.path}
                testId={`document-workspace-${doc.ref.kind}`}
                active={active}
              >
                <AssetDocumentWorkspace documentId={id} />
              </DocumentShell>
            </WorkspaceErrorBoundary>
          );
        }

        const isTypeAsset =
          doc.ref.kind === "enum" ||
          doc.ref.kind === "structure" ||
          doc.ref.kind === "script-interface";

        if (doc.ref.kind === "ui") {
          if (!shouldMount) return null;
          const indexed = assetRegistry
            ?.list()
            .find((asset) => asset.path === doc.ref.path);
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <PrefabEditingProvider>
                <GraphEditingProvider>
                <UiEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-ui"
                    active={active}
                  >
                    <UiDocumentDocks
                      id={id}
                      layout={doc.layout}
                      editorUtilityInterface={
                        indexed?.header.type === "EditorUtilityInterface"
                      }
                    />
                  </DocumentShell>
                </UiEditingProvider>
                </GraphEditingProvider>
                </PrefabEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (
          doc.ref.kind === "sprite" ||
          doc.ref.kind === "tileset" ||
          doc.ref.kind === "tilemap" ||
          doc.ref.kind === "plugin-settings"
        ) {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <DocumentShell
                  path={doc.ref.path}
                  testId={`document-workspace-${doc.ref.kind}`}
                  active={active}
                >
                  <RegisteredDockviewShell
                    id={id}
                    documentKind={doc.ref.kind}
                    initialLayout={doc.layout}
                  />
                </DocumentShell>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (isTypeAsset) {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <TypeAssetEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId={`document-workspace-${doc.ref.kind}`}
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind={doc.ref.kind}
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </TypeAssetEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
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
          <WorkspaceErrorBoundary key={id}>
            <DocumentWorkspaceProvider documentId={id}>
              <SceneEditingProvider
                initialViewportMode={sceneContent?.viewportMode ?? "3d"}
                documentViewportMode={sceneContent?.viewportMode}
                documentSnapEnabled={sceneContent?.settings?.grid?.snapEnabled}
                documentJoystickEnabled={
                  sceneContent?.settings?.editorJoystickEnabled
                }
                documentGridVisible={sceneContent?.settings?.grid?.showGrid}
              >
              <NavBakeProvider>
              <PrefabEditingProvider>
              <GraphEditingProvider>
              {doc.ref.kind === "scene" ? (
                <PendingSceneSearchFocus scenePath={doc.ref.path} />
              ) : null}
              <DocumentShell
                path={doc.ref.path}
                testId={`document-workspace-${doc.ref.kind}`}
                active={active}
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
              </DocumentShell>
              </GraphEditingProvider>
              </PrefabEditingProvider>
              </NavBakeProvider>
            </SceneEditingProvider>
            </DocumentWorkspaceProvider>
          </WorkspaceErrorBoundary>
        );
      })}
    </div>
  );
}

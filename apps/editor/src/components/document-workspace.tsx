import { CONTENT_BROWSER_ID, isAssetDocumentKind, isSceneWorkspaceKind, type SerializedScene } from "@babylonslate/core";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useLayoutEffect } from "react";
import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { useProjectSearch } from "../context/project-search-context";
import {
  SceneEditingProvider,
  useSceneEditing,
} from "../context/scene-editing-context";
import { NavBakeProvider } from "../context/nav-bake-context";
import { AudioReverbBakeProvider } from "../context/audio-reverb-bake-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { MaterialEditingProvider } from "../context/material-editing-context";
import { TypeAssetEditingProvider } from "../context/type-asset-editing-context";
import { TilesetEditingProvider } from "../context/tileset-editing-context";
import { TilemapEditingProvider } from "../context/tilemap-editing-context";
import { AnimGraphEditingProvider } from "../context/anim-graph-editing-context";
import { BehaviourTreeEditingProvider } from "../context/behaviour-tree-editing-context";
import { SpriteAnimationEditingProvider } from "./sprite-animation-editor";
import { TracePlaybackProvider } from "./trace-editor";
import { sceneFocusActorId } from "../lib/search-navigation";
import {
  useDocumentWorkingSet,
} from "../lib/document-working-set";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { AssetDocumentWorkspace } from "./asset-document-workspace";
import { DocumentLockBanner } from "./document-lock-banner";
import { WorkspaceErrorBoundary } from "./workspace-error-boundary";
import { DockviewShell } from "../shell/dockview-shell";
import {
  classDocumentShowsPrefab,
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";
import { walkAncestry } from "@babylonslate/editor-kit";
import {
  isDockviewDocumentKind,
  type DockviewDocumentKind,
} from "../shell/window-catalog";
import { AnimEditorModeBar } from "./anim-editor-mode-bar";
import { parseAnimDocumentLayout } from "../shell/anim-document-layout";
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
  animEditorMode,
  surface,
}: {
  id: string;
  documentKind: DockviewDocumentKind;
  initialLayout: Record<string, unknown> | null;
  actorPrefab?: boolean;
  animEditorMode?: import("../shell/anim-document-layout").AnimEditorMode;
  surface?: import("../shell/dockview-surface").DockviewSurface;
}) {
  const { registerDockviewApi, unregisterDockviewApi, captureLayoutForId, sourceControl } =
    useDocuments();
  const onReady = useCallback(
    (api: DockviewApi) => {
      registerDockviewApi(id, api, surface);
    },
    [id, registerDockviewApi, surface],
  );

  useLayoutEffect(() => {
    return () => {
      captureLayoutForId(id);
      unregisterDockviewApi(id, surface);
    };
  }, [id, surface, captureLayoutForId, unregisterDockviewApi]);

  return (
    <DockviewShell
      documentKind={documentKind}
      initialLayout={initialLayout}
      actorPrefab={actorPrefab}
      sourceControl={sourceControl.enabled}
      animEditorMode={animEditorMode}
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

export function AnimDocumentDocks({
  id,
  layout,
}: {
  id: string;
  layout: Record<string, unknown> | null;
}) {
  const { animEditorMode, setAnimEditorMode, activeDocumentId } = useDocuments();
  const parsed = parseAnimDocumentLayout(layout);
  const mode = activeDocumentId === id ? animEditorMode : parsed.animEditorMode;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AnimEditorModeBar
        mode={mode}
        onModeChange={(next) => setAnimEditorMode(id, next)}
      />
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0",
            mode === "stateMachine"
              ? "ui-dock-surface-active"
              : "ui-dock-surface-inactive",
          )}
          aria-hidden={mode !== "stateMachine"}
          inert={mode !== "stateMachine" ? true : undefined}
          data-testid="anim-dock-surface-state-machine"
          data-active={mode === "stateMachine" ? "true" : "false"}
        >
          {mode === "stateMachine" ? (
          <RegisteredDockviewShell
            id={id}
            documentKind="anim-graph"
            initialLayout={parsed.stateMachine}
            animEditorMode="stateMachine"
            surface="stateMachine"
          />
          ) : null}
        </div>
        <div
          className={cn(
            "absolute inset-0",
            mode === "animationObject"
              ? "ui-dock-surface-active"
              : "ui-dock-surface-inactive",
          )}
          aria-hidden={mode !== "animationObject"}
          inert={mode !== "animationObject" ? true : undefined}
          data-testid="anim-dock-surface-animation-object"
          data-active={mode === "animationObject" ? "true" : "false"}
        >
          {mode === "animationObject" ? (
          <RegisteredDockviewShell
            id={id}
            documentKind="anim-graph"
            initialLayout={parsed.animationObject}
            animEditorMode="animationObject"
            surface="animationObject"
          />
          ) : null}
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

  const projectKey = projectDocument?.metadata.name ?? null;

  const resolvedActiveId =
    tabOrder.length === 0
      ? null
      : activeDocumentId && tabOrder.includes(activeDocumentId)
        ? activeDocumentId
        : (tabOrder.find((id) => id === CONTENT_BROWSER_ID) ?? tabOrder[0]);

  const workingTabIds = projectKey ? tabOrder : [];
  const mountedIds = useDocumentWorkingSet(
    workingTabIds,
    projectKey ? resolvedActiveId : null,
    openDocuments.map((doc) => ({
      id: doc.id,
      kind: doc.ref.kind,
    })),
  );

  if (tabOrder.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to begin
      </div>
    );
  }

  return (
    <AudioReverbBakeProvider>
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
                <ContentBrowserWorkspace hidden={!active} />
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

        if (
          doc.ref.kind === "material" ||
          doc.ref.kind === "material-function"
        ) {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <MaterialEditingProvider documentId={id} active={active}>
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
                </MaterialEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "anim-graph") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <AnimGraphEditingProvider>
                  <PrefabEditingProvider initialSelectedId={null}>
                  <GraphEditingProvider>
                    <DocumentShell
                      path={doc.ref.path}
                      testId="document-workspace-anim-graph"
                      active={active}
                    >
                      <AnimDocumentDocks id={id} layout={doc.layout} />
                    </DocumentShell>
                  </GraphEditingProvider>
                  </PrefabEditingProvider>
                </AnimGraphEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "behaviour-tree") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <BehaviourTreeEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-behaviour-tree"
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind="behaviour-tree"
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </BehaviourTreeEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "sprite-animation") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <SpriteAnimationEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-sprite-animation"
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind="sprite-animation"
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </SpriteAnimationEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "tileset") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <TilesetEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-tileset"
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind="tileset"
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </TilesetEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "tilemap") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <TilemapEditingProvider>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-tilemap"
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind="tilemap"
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </TilemapEditingProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (doc.ref.kind === "trace") {
          if (!shouldMount) return null;
          return (
            <WorkspaceErrorBoundary key={id}>
              <DocumentWorkspaceProvider documentId={id}>
                <TracePlaybackProvider documentId={id}>
                  <DocumentShell
                    path={doc.ref.path}
                    testId="document-workspace-trace"
                    active={active}
                  >
                    <RegisteredDockviewShell
                      id={id}
                      documentKind="trace"
                      initialLayout={doc.layout}
                    />
                  </DocumentShell>
                </TracePlaybackProvider>
              </DocumentWorkspaceProvider>
            </WorkspaceErrorBoundary>
          );
        }

        if (
          doc.ref.kind === "sprite" ||
          doc.ref.kind === "plugin-settings" ||
          doc.ref.kind === "audio" ||
          doc.ref.kind === "audio-mixer" ||
          doc.ref.kind === "audio-channel" ||
          doc.ref.kind === "sound-attenuation" ||
          doc.ref.kind === "particle-emitter" ||
          doc.ref.kind === "particle-system" ||
          doc.ref.kind === "model" ||
          doc.ref.kind === "skeleton" ||
          doc.ref.kind === "animation" ||
          doc.ref.kind === "skybox-creator"
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
          isSceneWorkspaceKind(doc.ref.kind)
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
        const overlayPrefab =
          doc.ref.kind === "graph" &&
          walkAncestry(
            indexed
              ? classIdFromClassAsset(indexed)
              : (indexed?.header.parentClass ?? "Actor"),
            parentOf,
          ).includes("SceneLayerActor");
        const overlayWorkspace =
          doc.ref.kind === "scene-layer" || overlayPrefab;

        if (!shouldMount) return null;

        return (
          <WorkspaceErrorBoundary key={id}>
            <DocumentWorkspaceProvider documentId={id}>
              <SceneEditingProvider
                documentId={id}
                initialViewportMode={
                  overlayWorkspace ? "2d" : (sceneContent?.viewportMode ?? "3d")
                }
                initialViewportShadingMode={overlayWorkspace ? "unlit" : "pbr"}
                documentViewportMode={
                  overlayWorkspace ? "2d" : sceneContent?.viewportMode
                }
                documentSnapEnabled={sceneContent?.settings?.grid?.snapEnabled}
                documentJoystickEnabled={
                  sceneContent?.settings?.editorJoystickEnabled
                }
                documentGridVisible={sceneContent?.settings?.grid?.showGrid}
                documentNavmeshVisible={sceneContent?.settings?.showNavmesh}
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
                <RegisteredDockviewShell
                  id={id}
                  documentKind={
                    doc.ref.kind === "scene-layer"
                      ? "scene-layer"
                      : doc.ref.kind === "scene"
                        ? "scene"
                        : "graph"
                  }
                  initialLayout={doc.layout}
                  actorPrefab={actorPrefab}
                />
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
    </AudioReverbBakeProvider>
  );
}

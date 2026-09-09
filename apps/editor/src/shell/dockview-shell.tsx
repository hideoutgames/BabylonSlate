import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import type { DockviewDocumentKind } from "./default-layout";
import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import { createDefaultLayoutForKind } from "./default-layout";
import { migrateRestoredLayout, restoreDockviewLayout } from "./layout-ops";
import { panelComponents } from "./panel-registry";
import {
  usePlatformLayoutOptions,
  useTouchLayout,
} from "./use-platform-layout";
import type { AnimEditorMode } from "./anim-document-layout";
import {
  enterPhoneDockLayout,
  inlineDetachedDockviewLayout,
} from "./phone-dock-layout";
import { PhoneWindowSwitcher } from "./phone-window-switcher";
import { listDockWindows, primaryDockPanel } from "./window-catalog";
import { EditorWindowRail } from "./editor-window-rail";

export interface DockviewShellProps {
  documentKind: DockviewDocumentKind;
  onReady?: (api: DockviewApi) => void;
  initialLayout?: Record<string, unknown> | null;
  actorPrefab?: boolean;
  sourceControl?: boolean;
  animEditorMode?: AnimEditorMode;
}

export function DockviewShell({
  documentKind,
  onReady,
  initialLayout,
  actorPrefab = true,
  sourceControl = false,
  animEditorMode,
}: DockviewShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const phoneLayoutRef = useRef<ReturnType<typeof enterPhoneDockLayout> | null>(
    null,
  );
  const initialDesktopLayoutRef = useRef<
    ReturnType<DockviewApi["toJSON"]> | undefined
  >(undefined);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialLayoutRef = useRef(initialLayout);
  initialLayoutRef.current = initialLayout;
  const platformOptions = usePlatformLayoutOptions();
  const touch = useTouchLayout();

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      const originalLayout = initialLayoutRef.current;
      const hostLayout =
        originalLayout && platformOptions.disableFloatingGroups
          ? inlineDetachedDockviewLayout(
              originalLayout as unknown as ReturnType<DockviewApi["toJSON"]>,
            )
          : originalLayout;
      restoreDockviewLayout(
        event.api,
        hostLayout as Record<string, unknown> | null,
        () => {
          createDefaultLayoutForKind(event.api, documentKind, {
            actorPrefab,
            sourceControl,
            animEditorMode,
          });
        },
      );
      migrateRestoredLayout(event.api);
      if (!actorPrefab) {
        event.api.getPanel("prefab-viewport")?.api.close();
        event.api.getPanel("actor-prefab")?.api.close();
      }
      if (!sourceControl) {
        event.api.getPanel("locks")?.api.close();
      }
      if (
        platformOptions.singleWindow &&
        hostLayout !== originalLayout &&
        originalLayout
      ) {
        const saved = originalLayout as unknown as ReturnType<
          DockviewApi["toJSON"]
        >;
        const panelIds = Object.keys(saved.panels ?? {});
        // Invalid/retired catalog layouts keep the safe migration/default instead.
        if (
          panelIds.length === event.api.panels.length &&
          panelIds.every((id) => event.api.getPanel(id))
        ) {
          initialDesktopLayoutRef.current = saved;
        }
      }

      setApi(event.api);
      onReadyRef.current?.(event.api);
    },
    [
      documentKind,
      actorPrefab,
      sourceControl,
      animEditorMode,
      platformOptions.disableFloatingGroups,
      platformOptions.singleWindow,
    ],
  );

  useLayoutEffect(() => {
    if (!api) return;
    const updateSelection = () => setActivePanelId(api.activePanel?.id ?? null);
    updateSelection();
    const subscription = api.onDidActivePanelChange(updateSelection);
    return () => subscription.dispose();
  }, [api]);

  useLayoutEffect(() => {
    if (!api) return;
    if (platformOptions.singleWindow && !phoneLayoutRef.current) {
      phoneLayoutRef.current = enterPhoneDockLayout(
        api,
        initialDesktopLayoutRef.current,
      );
      initialDesktopLayoutRef.current = undefined;
    } else if (!platformOptions.singleWindow && phoneLayoutRef.current) {
      phoneLayoutRef.current.restore({
        allowDetached: !platformOptions.disableFloatingGroups,
      });
      phoneLayoutRef.current = null;
    }
  }, [
    api,
    platformOptions.singleWindow,
    platformOptions.disableFloatingGroups,
  ]);

  useLayoutEffect(() => () => phoneLayoutRef.current?.dispose(), []);

  const windows = listDockWindows(documentKind, {
    actorPrefab,
    sourceControl,
    animEditorMode,
  });
  const selectWindow = (id: string) => {
    const dock = apiRef.current;
    if (!dock) return;
    const existing = dock.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const window = windows.find((entry) => entry.id === id);
    if (window) {
      dock.addPanel({
        id: window.id,
        component: window.component,
        title: window.title,
      });
    }
  };

  return (
    <div
      className={cn(
        "editor-dock-workspace flex h-full min-h-0 min-w-0 flex-1",
        platformOptions.singleWindow && "flex-col",
      )}
      data-layout={platformOptions.singleWindow ? "phone" : "docked"}
      data-touch={touch ? "true" : "false"}
    >
      {!platformOptions.singleWindow && (
        <EditorWindowRail
          api={api}
          windows={windows}
          primaryId={primaryDockPanel(documentKind, { animEditorMode })}
          touch={touch}
          animEditorMode={animEditorMode}
        />
      )}
      <div className="editor-dock-surface min-h-0 min-w-0 flex-1">
        <DockviewReact
          className={cn(
            "dockview-theme-babylonslate h-full w-full",
            platformOptions.singleWindow && "phone-dockview",
          )}
          dndStrategy={platformOptions.dndStrategy}
          disableDnd={platformOptions.singleWindow}
          disableFloatingGroups={platformOptions.disableFloatingGroups}
          onReady={handleReady}
          components={panelComponents}
        />
      </div>
      {platformOptions.singleWindow && (
        <PhoneWindowSwitcher
          windows={windows}
          activeId={activePanelId}
          onSelect={selectWindow}
        />
      )}
    </div>
  );
}

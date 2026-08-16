import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import type { DockviewDocumentKind } from "./default-layout";
import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import { useCallback, useRef } from "react";
import { createDefaultLayoutForKind } from "./default-layout";
import { migrateRestoredLayout, restoreDockviewLayout } from "./layout-ops";
import { panelComponents } from "./panel-registry";
import { usePlatformLayoutOptions } from "./use-platform-layout";
import type { UiEditorMode } from "./ui-document-layout";

export interface DockviewShellProps {
  documentKind: DockviewDocumentKind;
  onReady?: (api: DockviewApi) => void;
  initialLayout?: Record<string, unknown> | null;
  actorPrefab?: boolean;
  editorUtilityInterface?: boolean;
  sourceControl?: boolean;
  uiEditorMode?: UiEditorMode;
}

export function DockviewShell({
  documentKind,
  onReady,
  initialLayout,
  actorPrefab = true,
  editorUtilityInterface = false,
  sourceControl = false,
  uiEditorMode,
}: DockviewShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialLayoutRef = useRef(initialLayout);
  initialLayoutRef.current = initialLayout;
  const platformOptions = usePlatformLayoutOptions();

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      restoreDockviewLayout(event.api, initialLayoutRef.current, () => {
        createDefaultLayoutForKind(event.api, documentKind, {
          actorPrefab,
          editorUtilityInterface,
          sourceControl,
          uiEditorMode,
        });
      });
      migrateRestoredLayout(event.api);
      if (!actorPrefab) {
        event.api.getPanel("prefab-viewport")?.api.close();
        event.api.getPanel("actor-prefab")?.api.close();
      }
      if (!editorUtilityInterface) {
        event.api.getPanel("ui-settings")?.api.close();
      }
      if (!sourceControl) {
        event.api.getPanel("locks")?.api.close();
      }

      if (platformOptions.disableFloatingGroups) {
        event.api.onDidAddPanel(() => {
          // Floating groups disabled on mobile via CSS + platform policy.
        });
      }

      onReadyRef.current?.(event.api);
    },
    [documentKind, actorPrefab, editorUtilityInterface, sourceControl, uiEditorMode, platformOptions.disableFloatingGroups],
  );

  return (
    <DockviewReact
      className="dockview-theme-babylonslate h-full w-full"
      dndStrategy={platformOptions.dndStrategy}
      disableFloatingGroups={platformOptions.disableFloatingGroups}
      onReady={handleReady}
      components={panelComponents}
    />
  );
}

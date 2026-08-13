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
import { migrateRestoredLayout } from "./layout-ops";
import { panelComponents } from "./panel-registry";
import { usePlatformLayoutOptions } from "./use-platform-layout";

export interface DockviewShellProps {
  documentKind: DockviewDocumentKind;
  onReady?: (api: DockviewApi) => void;
  initialLayout?: Record<string, unknown> | null;
  actorPrefab?: boolean;
}

export function DockviewShell({
  documentKind,
  onReady,
  initialLayout,
  actorPrefab = true,
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

      const layout = initialLayoutRef.current;
      if (layout) {
        event.api.fromJSON(layout as never);
      } else {
        createDefaultLayoutForKind(event.api, documentKind, {
          actorPrefab,
        });
      }
      migrateRestoredLayout(event.api);
      if (!actorPrefab) {
        event.api.getPanel("prefab-viewport")?.api.close();
        event.api.getPanel("actor-prefab")?.api.close();
      }

      if (platformOptions.disableFloatingGroups) {
        event.api.onDidAddPanel(() => {
          // Floating groups disabled on mobile via CSS + platform policy.
        });
      }

      onReadyRef.current?.(event.api);
    },
    [documentKind, actorPrefab, platformOptions.disableFloatingGroups],
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

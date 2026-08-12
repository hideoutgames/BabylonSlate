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
}

export function DockviewShell({
  documentKind,
  onReady,
  initialLayout,
}: DockviewShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const platformOptions = usePlatformLayoutOptions();

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      if (initialLayout) {
        event.api.fromJSON(initialLayout as never);
      } else {
        createDefaultLayoutForKind(event.api, documentKind);
      }
      migrateRestoredLayout(event.api);

      if (platformOptions.disableFloatingGroups) {
        event.api.onDidAddPanel(() => {
          // Floating groups disabled on mobile via CSS + platform policy.
        });
      }

      onReady?.(event.api);
    },
    [documentKind, initialLayout, onReady, platformOptions.disableFloatingGroups],
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

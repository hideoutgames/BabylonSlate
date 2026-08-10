import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "./dockview-theme.css";
import { useCallback, useRef } from "react";
import { createDefaultLayout } from "./default-layout";
import { panelComponents } from "./panel-registry";
import { usePlatformLayoutOptions } from "./use-platform-layout";

export interface DockviewShellProps {
  onReady?: (api: DockviewApi) => void;
  initialLayout?: Record<string, unknown> | null;
}

export function DockviewShell({ onReady, initialLayout }: DockviewShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const platformOptions = usePlatformLayoutOptions();

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      if (initialLayout) {
        event.api.fromJSON(initialLayout as never);
      } else {
        createDefaultLayout(event.api);
      }

      if (platformOptions.disableFloatingGroups) {
        event.api.onDidAddPanel(() => {
          // Floating groups disabled on mobile via CSS + platform policy.
        });
      }

      onReady?.(event.api);
    },
    [initialLayout, onReady, platformOptions.disableFloatingGroups],
  );

  return (
    <DockviewReact
      className="dockview-theme-babylonslate h-full w-full"
      onReady={handleReady}
      components={panelComponents}
    />
  );
}

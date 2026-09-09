import { useCallback, useSyncExternalStore } from "react";
import type { DockviewApi } from "dockview-react";
import {
  AppWindowIcon,
  BoxIcon,
  BracesIcon,
  CameraIcon,
  CheckCheckIcon,
  ComponentIcon,
  FilmIcon,
  FocusIcon,
  GitBranchIcon,
  LayersIcon,
  ListTreeIcon,
  LockKeyholeIcon,
  Maximize2Icon,
  PaletteIcon,
  PanelsTopLeftIcon,
  ScanEyeIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import { useDocuments } from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";
import type { AnimEditorMode, DockWindowDefinition } from "./window-catalog";

const WINDOW_ICONS: Record<string, LucideIcon> = {
  Viewport: BoxIcon,
  Outliner: ListTreeIcon,
  Details: SlidersHorizontalIcon,
  "Output Log": TerminalIcon,
  "Compiler Results": CheckCheckIcon,
  Graph: GitBranchIcon,
  Prefab: BoxIcon,
  Components: ComponentIcon,
  Class: BracesIcon,
  Inspector: ScanEyeIcon,
  Members: LayersIcon,
  Preview: CameraIcon,
  Methods: BracesIcon,
  Colliders: ShieldIcon,
  Timeline: FilmIcon,
  Snapshot: CameraIcon,
  Log: TerminalIcon,
  Clips: FilmIcon,
  Cubemap: BoxIcon,
  Paint: PaletteIcon,
  Palette: PaletteIcon,
  Interface: ComponentIcon,
  Variables: BracesIcon,
  Blackboard: LayersIcon,
  Locks: LockKeyholeIcon,
};

export interface EditorWindowRailProps {
  api: DockviewApi | null;
  windows: readonly DockWindowDefinition[];
  primaryId: string;
  touch: boolean;
  animEditorMode?: AnimEditorMode;
}

/** Catalog navigation shares the Windows menu's placement and Focus lifecycle. */
export function EditorWindowRail({
  api,
  windows,
  primaryId,
  touch,
  animEditorMode,
}: EditorWindowRailProps) {
  const {
    activeDocumentId,
    animEditorMode: activeAnimEditorMode,
    isLayoutFocused,
    toggleDockWindow,
    toggleLayoutFocus,
  } = useDocuments();
  const workspace = useOptionalDocumentWorkspace();
  const enabled =
    api !== null &&
    (!workspace || workspace.documentId === activeDocumentId) &&
    (!animEditorMode || animEditorMode === activeAnimEditorMode);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!api) return () => {};
      const subscriptions = [
        api.onDidAddPanel(onChange),
        api.onDidRemovePanel(onChange),
        api.onDidActivePanelChange(onChange),
        api.onDidLayoutChange(onChange),
      ];
      return () =>
        subscriptions.forEach((subscription) => subscription.dispose());
    },
    [api],
  );
  const snapshot = useCallback(
    () =>
      api
        ? api.panels
            .map(
              (panel) =>
                `${panel.id}:${panel.api.isVisible}:${panel.api.isActive}`,
            )
            .join("|")
        : "",
    [api],
  );
  useSyncExternalStore(subscribe, snapshot, () => "");

  const selectWindow = (id: string) => {
    if (!enabled || !api) return;
    const panel = api.getPanel(id);
    if (panel && (id === primaryId || !panel.api.isVisible)) {
      panel.api.setActive();
      return;
    }
    toggleDockWindow(id);
  };

  return (
    <nav className="editor-window-rail" aria-label="Editor Windows">
      <div className="editor-window-rail-items">
        {windows.map((window) => {
          const panel = api?.getPanel(window.id);
          const open = Boolean(panel);
          const visible = Boolean(panel?.api.isVisible);
          const primary = window.id === primaryId;
          const Icon = WINDOW_ICONS[window.title] ?? AppWindowIcon;
          const label = primary
            ? `Show ${window.title}`
            : `${visible ? "Hide" : "Show"} ${window.title}`;
          const content = (
            <>
              <Icon data-icon="inline-start" />
              <span className="editor-window-rail-label">{window.title}</span>
            </>
          );
          const properties = {
            className: "editor-window-rail-item",
            "aria-label": label,
            "data-testid": `editor-window-${window.id}`,
            "data-open": open,
            "data-visible": visible,
            "data-active": Boolean(panel?.api.isActive),
            disabled:
              !enabled || (!primary && visible && api?.panels.length === 1),
          };
          return (
            <Tooltip key={window.id}>
              <TooltipTrigger
                render={
                  primary ? (
                    <Button
                      {...properties}
                      variant="ghost"
                      size={touch ? "touch" : "icon"}
                      aria-current={visible ? "true" : undefined}
                      onClick={() => selectWindow(window.id)}
                    >
                      {content}
                    </Button>
                  ) : (
                    <Toggle
                      {...properties}
                      variant="default"
                      size={touch ? "touch" : "default"}
                      pressed={visible}
                      onPressedChange={() => selectWindow(window.id)}
                    >
                      {content}
                    </Toggle>
                  )
                }
              />
              <TooltipContent side={touch ? "top" : "right"}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="editor-window-rail-footer">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                variant="default"
                size={touch ? "touch" : "default"}
                className="editor-window-rail-item"
                aria-label={
                  isLayoutFocused ? "Restore Windows" : "Focus Workspace"
                }
                data-testid="editor-window-focus"
                pressed={isLayoutFocused}
                disabled={!enabled}
                onPressedChange={() => toggleLayoutFocus()}
              >
                {isLayoutFocused ? (
                  <PanelsTopLeftIcon data-icon="inline-start" />
                ) : touch ? (
                  <FocusIcon data-icon="inline-start" />
                ) : (
                  <Maximize2Icon data-icon="inline-start" />
                )}
                <span className="editor-window-rail-label">
                  {isLayoutFocused ? "Restore" : "Focus"}
                </span>
              </Toggle>
            }
          />
          <TooltipContent side={touch ? "top" : "right"}>
            {isLayoutFocused ? "Restore Windows" : "Focus Workspace"}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

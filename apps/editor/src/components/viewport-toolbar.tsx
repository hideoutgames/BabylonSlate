import { NestedMenu, NumberPromptDialog, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import type { SerializedScene } from "@babylonslate/core";
import { isSceneWorkspaceKind } from "@babylonslate/core";
import type { GizmoTool, ViewportShadingMode } from "@babylonslate/render";
import {
  MoveIcon,
  RotateCwIcon,
  ScalingIcon,
  Settings2Icon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { useState } from "react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import {
  patchEngineViewportPrefs,
  useEditorViewportPrefs,
} from "../lib/viewport-engine-prefs";

const TOOLS: Array<{
  id: GizmoTool;
  label: string;
  icon: typeof MoveIcon;
}> = [
  { id: "translate", label: "Move", icon: MoveIcon },
  { id: "rotate", label: "Rotate", icon: RotateCwIcon },
  { id: "scale", label: "Scale", icon: ScalingIcon },
];

export function ViewportToolbar({
  testIdPrefix = "",
  showDragSelect = true,
  showViewportModeToggle = true,
  showGizmoTools = true,
}: {
  testIdPrefix?: string;
  showDragSelect?: boolean;
  showViewportModeToggle?: boolean;
  showGizmoTools?: boolean;
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const { flySpeed, gridSize } = useEditorViewportPrefs();
  const [numberPrompt, setNumberPrompt] = useState<
    null | "grid" | "camera"
  >(null);
  const {
    gizmoTool,
    setGizmoTool,
    snapEnabled,
    setSnapEnabled,
    joystickEnabled,
    setJoystickEnabled,
    gridVisible,
    setGridVisible,
    navmeshVisible,
    setNavmeshVisible,
    dragSelectActive,
    setDragSelectActive,
    viewportMode,
    setViewportMode,
    previewGameCamera,
    setPreviewGameCamera,
    pivotAroundCenter,
    setPivotAroundCenter,
    viewportShadingMode,
    setViewportShadingMode,
  } = useSceneEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;

  const setMode = (next: "2d" | "3d") => {
    setViewportMode(next);
    if (scene && scene.viewportMode !== next) {
      void applySceneChange(documentId, { ...scene, viewportMode: next });
    }
  };

  const toggleJoystick = (enabled: boolean) => {
    setJoystickEnabled(enabled);
    if (scene && scene.settings.editorJoystickEnabled !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: { ...scene.settings, editorJoystickEnabled: enabled },
      });
    }
  };

  const toggleSnap = (enabled: boolean) => {
    setSnapEnabled(enabled);
    if (scene && scene.settings.grid.snapEnabled !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: {
          ...scene.settings,
          grid: { ...scene.settings.grid, snapEnabled: enabled },
        },
      });
    }
  };

  const toggleGrid = (enabled: boolean) => {
    setGridVisible(enabled);
    if (scene && scene.settings.grid.showGrid !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: {
          ...scene.settings,
          grid: { ...scene.settings.grid, showGrid: enabled },
        },
      });
    }
  };

  const toggleNavmesh = (enabled: boolean) => {
    setNavmeshVisible(enabled);
    if (scene && scene.settings.showNavmesh !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: { ...scene.settings, showNavmesh: enabled },
      });
    }
  };

  const settingsItems: NestedMenuItem[] = [
    {
      type: "submenu",
      id: "viewport-mode",
      label: "Viewport Mode",
      testId: `${testIdPrefix}viewport-shading-mode`,
      items: [
        {
          type: "radio-group",
          id: "viewport-shading",
          value: viewportShadingMode,
          closeOnClick: false,
          onValueChange: (value) =>
            setViewportShadingMode(value as ViewportShadingMode),
          items: [
            {
              id: "pbr",
              label: "PBR",
              value: "pbr",
              testId: `${testIdPrefix}viewport-shading-pbr`,
            },
            {
              id: "unlit",
              label: "Unlit",
              value: "unlit",
              testId: `${testIdPrefix}viewport-shading-unlit`,
            },
            {
              id: "wireframe",
              label: "Wireframe",
              value: "wireframe",
              testId: `${testIdPrefix}viewport-shading-wireframe`,
            },
          ],
        },
      ],
    },
    {
      type: "checkbox",
      id: "snap",
      label: "Snap",
      checked: snapEnabled,
      closeOnClick: false,
      testId: `${testIdPrefix}gizmo-snap-toggle`,
      onCheckedChange: toggleSnap,
    },
    {
      type: "checkbox",
      id: "show-grid",
      label: "Show Grid",
      checked: gridVisible,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-show-grid-toggle`,
      onCheckedChange: toggleGrid,
    },
    {
      type: "checkbox",
      id: "show-navmesh",
      label: "Show Navmesh",
      checked: navmeshVisible,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-show-navmesh-toggle`,
      onCheckedChange: toggleNavmesh,
    },
    {
      type: "checkbox",
      id: "joystick",
      label: "Joystick",
      checked: joystickEnabled,
      closeOnClick: false,
      testId: `${testIdPrefix}gizmo-joystick-toggle`,
      onCheckedChange: toggleJoystick,
    },
    {
      type: "checkbox",
      id: "pivot-around-center",
      label: "Pivot Around Center",
      checked: pivotAroundCenter,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-pivot-around-center-toggle`,
      onCheckedChange: setPivotAroundCenter,
    },
    {
      type: "checkbox",
      id: "game-camera",
      label: "Game Camera",
      checked: previewGameCamera,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-game-camera-toggle`,
      onCheckedChange: setPreviewGameCamera,
    },
    {
      type: "submenu",
      id: "settings",
      label: "Settings",
      testId: `${testIdPrefix}viewport-settings-submenu`,
      items: [
        {
          id: "grid-size",
          label: "Grid Size",
          testId: `${testIdPrefix}viewport-grid-size`,
          onSelect: () => setNumberPrompt("grid"),
        },
        {
          id: "camera-speed",
          label: "Camera Speed",
          testId: `${testIdPrefix}viewport-camera-speed`,
          onSelect: () => setNumberPrompt("camera"),
        },
      ],
    },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testIdPrefix}viewport-toolbar`}
    >
      {showGizmoTools ? (
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={[gizmoTool]}
          onValueChange={(value) => {
            const next = value[0] as GizmoTool | undefined;
            if (next) setGizmoTool(next);
          }}
          aria-label="Gizmo tool"
        >
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            const active = gizmoTool === tool.id;
            return (
              <ToggleGroupItem
                key={tool.id}
                value={tool.id}
                aria-label={tool.label}
                data-testid={`${testIdPrefix}gizmo-tool-${tool.id}`}
              >
                <Icon />
                <span
                  data-testid="gizmo-tool-label"
                  className="grid min-w-0 overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
                  style={{ gridTemplateColumns: active ? "1fr" : "0fr" }}
                  aria-hidden={!active}
                >
                  <span className="min-w-0 overflow-hidden whitespace-nowrap">
                    {tool.label}
                  </span>
                </span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      ) : null}
      {showDragSelect ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                variant="outline"
                size="sm"
                aria-label="Drag Select"
                pressed={dragSelectActive}
                onPressedChange={(pressed) => setDragSelectActive(pressed)}
                data-testid={`${testIdPrefix}viewport-drag-select`}
              >
                <SquareDashedMousePointerIcon />
              </Toggle>
            }
          />
          <TooltipContent>Drag Select</TooltipContent>
        </Tooltip>
      ) : null}
      <NestedMenu
        items={settingsItems}
        size="chrome"
        align="end"
        contentTestId={`${testIdPrefix}viewport-settings-menu`}
        contentClassName="w-max min-w-56 whitespace-nowrap"
        trigger={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Viewport Settings"
            data-testid={`${testIdPrefix}viewport-settings`}
          />
        }
      >
        <Settings2Icon />
      </NestedMenu>
      {showViewportModeToggle ? (
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[viewportMode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "2d" || next === "3d") setMode(next);
        }}
        aria-label="2D / 3D"
        data-testid={`${testIdPrefix}viewport-mode-toggle`}
      >
        <ToggleGroupItem
          value="3d"
          aria-label="3D viewport"
          data-testid={`${testIdPrefix}viewport-mode-3d`}
        >
          3D
        </ToggleGroupItem>
        <ToggleGroupItem
          value="2d"
          aria-label="2D viewport"
          data-testid={`${testIdPrefix}viewport-mode-2d`}
        >
          2D
        </ToggleGroupItem>
      </ToggleGroup>
      ) : null}
      <NumberPromptDialog
        open={numberPrompt === "grid"}
        onOpenChange={(open) => {
          if (!open) setNumberPrompt(null);
        }}
        title="Grid Size"
        label="Grid Size"
        description="Visible size of one grid cell and the translate snap step."
        initialValue={scene?.settings.grid.tileSize ?? gridSize}
        data-testid={`${testIdPrefix}viewport-grid-size-dialog`}
        onSubmit={(value) => {
          if (scene) {
            void applySceneChange(documentId, {
              ...scene,
              settings: {
                ...scene.settings,
                grid: {
                  ...scene.settings.grid,
                  tileSize: value,
                  snapTranslate: value,
                },
              },
            });
            return;
          }
          void patchEngineViewportPrefs({ viewportGridSize: value });
        }}
      />
      <NumberPromptDialog
        open={numberPrompt === "camera"}
        onOpenChange={(open) => {
          if (!open) setNumberPrompt(null);
        }}
        title="Camera Speed"
        label="Camera Speed"
        description="How fast the editor camera flies in world units per second."
        initialValue={flySpeed}
        data-testid={`${testIdPrefix}viewport-camera-speed-dialog`}
        onSubmit={(value) => {
          void patchEngineViewportPrefs({ viewportFlySpeed: value });
        }}
      />
    </div>
  );
}

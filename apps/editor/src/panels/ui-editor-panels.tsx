import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PanelFrame } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { GraphEditor } from "@babylonslate/graph-ui";
import {
  DESIRED_CANVAS_ID,
  type DesignerCanvasId,
  type ScaleRule,
} from "@babylonslate/ui-runtime";
import { normalizeEditorUtilityDockKind } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useOptionalDocumentWorkspace } from "../context/document-workspace-context";
import { useUiEditing } from "../context/ui-editing-context";
import { UiDesignCanvas } from "../components/ui-design-canvas";
import { UiDesignHierarchy } from "../components/ui-design-hierarchy";
import { UiDesignDetails } from "../components/ui-design-details";
import { ClassMembersView } from "./my-class-panel";
import {
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
} from "../services/graph-validation";

const SCALE_RULES: Array<{ value: ScaleRule; label: string }> = [
  { value: "shortestSide", label: "Shortest Side" },
  { value: "fitWidth", label: "Fit Width" },
  { value: "fitHeight", label: "Fit Height" },
];

function useDockPanelVisible(props: IDockviewPanelProps): boolean {
  const [panelVisible, setPanelVisible] = useState(props.api?.isVisible ?? true);
  useEffect(() => {
    setPanelVisible(props.api?.isVisible ?? true);
    const api = props.api as IDockviewPanelProps["api"] & {
      onDidVisibilityChange?: (cb: (event: { isVisible: boolean }) => void) => {
        dispose: () => void;
      };
    };
    const sub = api?.onDidVisibilityChange?.((event) => {
      setPanelVisible(event.isVisible);
    });
    return () => sub?.dispose();
  }, [props.api]);
  return panelVisible;
}

export function UiDesignPanel(props: IDockviewPanelProps) {
  const panelVisible = useDockPanelVisible(props);
  const workspace = useOptionalDocumentWorkspace();
  const { activeDocumentId } = useDocuments();
  const editing = useUiEditing();
  const viewportMeasureRef = useRef<HTMLDivElement>(null);
  const setViewportSize = editing.setViewportSize;
  const documentActive = workspace
    ? activeDocumentId === workspace.documentId
    : true;

  useEffect(() => {
    const el = viewportMeasureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [setViewportSize]);

  return (
    <PanelFrame data-testid="ui-design-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="ui-add-widget"
            onClick={() => editing.setCatalogOpen(true)}
          >
            Add Widget
          </Button>
          <Select
            value={editing.presetId}
            onValueChange={(value) =>
              editing.setPresetId(value as DesignerCanvasId)
            }
          >
            <SelectTrigger className="w-48" data-testid="ui-device-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={DESIRED_CANVAS_ID} data-testid="ui-preset-desired">
                  Desired
                </SelectItem>
                {editing.devicePresets.map((row) => (
                  <SelectItem
                    key={row.id}
                    value={row.id}
                    data-testid={`ui-preset-${row.id}`}
                  >
                    {row.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={editing.ui.scaleRule}
            onValueChange={(value) =>
              editing.commit({
                ...editing.payload,
                ...editing.ui,
                scaleRule: value as ScaleRule,
              })
            }
          >
            <SelectTrigger className="w-40" data-testid="ui-scale-rule">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SCALE_RULES.map((row) => (
                  <SelectItem key={row.value} value={row.value}>
                    {row.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            data-testid="ui-design-fit"
            onClick={editing.fitView}
          >
            Fit
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="ui-design-zoom">
            {Math.round(editing.view.zoom * 100)}%
          </span>
        </div>
        <div ref={viewportMeasureRef} className="flex min-h-0 min-w-0 flex-1">
          <UiDesignCanvas
            ui={editing.ui}
            viewport={editing.viewport}
            layout={editing.layout}
            controls={editing.controls}
            selectedId={editing.selectedId}
            view={editing.view}
            previewScale={editing.previewScale}
            bitmapScale={editing.bitmapScale}
            sharedEngine={editing.sharedEngine}
            fontEntries={editing.fontEntries}
            panelVisible={panelVisible}
            documentActive={documentActive}
            onSelect={editing.setSelectedId}
            onViewChange={editing.setView}
            onLayoutChange={(id, nextLayout, mergeKey) =>
              editing.patchLayout(id, nextLayout, mergeKey)
            }
          />
        </div>
      </div>
    </PanelFrame>
  );
}

export function UiHierarchyPanel(_props: IDockviewPanelProps) {
  void _props;
  const { ui, selectedId, setSelectedId, commit, payload } = useUiEditing();
  return (
    <PanelFrame data-testid="ui-hierarchy-panel">
      <UiDesignHierarchy
        ui={ui}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onChange={(next) => commit({ ...payload, ...next })}
      />
    </PanelFrame>
  );
}

export function UiDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    ui,
    selected,
    layout,
    actionNames,
    assetLabels,
    patchWidget,
    patchLayout,
    setAssetPick,
  } = useUiEditing();
  if (!selected) {
    return (
      <PanelFrame data-testid="ui-details-panel">
        <p className="p-3 text-sm text-muted-foreground">Select a widget.</p>
      </PanelFrame>
    );
  }
  return (
    <PanelFrame data-testid="ui-details-panel">
      <UiDesignDetails
        ui={ui}
        selected={selected}
        layout={layout}
        actionNames={actionNames}
        assetLabels={assetLabels}
        onPatchWidget={patchWidget}
        onPatchLayout={(id, nextLayout) => patchLayout(id, nextLayout)}
        onPickAsset={setAssetPick}
      />
    </PanelFrame>
  );
}

export function UiLogicPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    payload,
    logic,
    logicMemberId,
    setLogicMemberId,
    interfaceAssets,
    commit,
  } = useUiEditing();
  const paletteNodes = useMemo(() => scriptPaletteNodes(), []);
  return (
    <PanelFrame data-testid="ui-logic-panel">
      <div className="flex h-full min-h-0">
        <div className="w-56 shrink-0 border-r border-border" data-testid="ui-logic-members">
          <ClassMembersView
            graph={logic}
            selectedId={logicMemberId}
            interfaceAssets={interfaceAssets}
            onGraphChange={(next) => commit({ ...payload, logic: next })}
            onSelectMember={(id) => setLogicMemberId(id || null)}
          />
        </div>
        <GraphEditor
          initialGraph={hydrateSerializedGraphForEditor(logic)}
          paletteNodes={paletteNodes}
          onChange={(graph) =>
            commit({
              ...payload,
              logic: {
                ...graph,
                members: graph.members ?? logic.members,
              },
            })
          }
        />
      </div>
    </PanelFrame>
  );
}

export function UiSettingsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit, isEditorUtilityInterface, dockKind } = useUiEditing();
  return (
    <PanelFrame data-testid="ui-settings-panel">
      <FieldGroup className="p-3">
        <Field>
          <FieldLabel>Dock Kind</FieldLabel>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={1}
            value={[dockKind]}
            disabled={!isEditorUtilityInterface}
            onValueChange={(value) => {
              const next = value[0];
              if (!next) return;
              commit({
                ...payload,
                dockKind: normalizeEditorUtilityDockKind(next),
              });
            }}
            aria-label="Dock Kind"
            data-testid="ui-dock-kind"
          >
            <ToggleGroupItem value="scene" data-testid="ui-dock-kind-scene">
              Scene
            </ToggleGroupItem>
            <ToggleGroupItem value="class" data-testid="ui-dock-kind-class">
              Class
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
    </PanelFrame>
  );
}

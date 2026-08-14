import type { IDockviewPanelProps } from "dockview-react";
import { UiEditingProvider } from "../context/ui-editing-context";
import {
  UiDesignPanel,
  UiDetailsPanel,
  UiHierarchyPanel,
  UiLogicPanel,
  UiSettingsPanel,
} from "../panels/ui-editor-panels";

const STUB_DOCK_PROPS = {
  api: {
    isVisible: true,
    onDidVisibilityChange: () => ({ dispose: () => {} }),
  },
} as unknown as IDockviewPanelProps;

/** Test and gallery host: production UserInterface tabs use Dockview panels. */
export function UiDesigner({
  path,
  payload,
  onChange,
  editorUtilityInterface = false,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
  editorUtilityInterface?: boolean;
}) {
  return (
    <UiEditingProvider path={path} payload={payload} onChange={onChange}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="w-56 shrink-0 border-r border-border">
            <UiHierarchyPanel {...STUB_DOCK_PROPS} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <UiDesignPanel {...STUB_DOCK_PROPS} />
          </div>
          <div className="w-72 shrink-0 border-l border-border">
            <UiDetailsPanel {...STUB_DOCK_PROPS} />
          </div>
        </div>
        <div className="h-64 shrink-0 border-t border-border">
          <UiLogicPanel {...STUB_DOCK_PROPS} />
        </div>
        {editorUtilityInterface ? (
          <div className="h-40 shrink-0 border-t border-border">
            <UiSettingsPanel {...STUB_DOCK_PROPS} />
          </div>
        ) : null}
      </div>
    </UiEditingProvider>
  );
}

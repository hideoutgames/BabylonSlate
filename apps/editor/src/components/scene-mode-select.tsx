import { useToolbarOverflowEntry } from "@haptic/editor-kit";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@haptic/ui/components/select";
import { useActiveDocumentState, useDocumentActions } from "../context/document-context";
import { SCENE_MODE_LABELS, normalizeSceneMode, sceneModesForKind } from "../shell/scene-document-layout";
import { TOOLBAR_OVERFLOW_PRIORITY } from "../lib/toolbar-overflow-priority";

/** Scene: Design / Landscape / Foliage / Script. Scene Layer: Design / Script. */
export function SceneModeSelect({ kind, disabled = false }: { kind: "scene" | "scene-layer"; disabled?: boolean }) {
  const { setSceneMode } = useDocumentActions();
  const { sceneMode, activeDocumentId } = useActiveDocumentState();
  const modes = sceneModesForKind(kind);
  const chooseMode = (value: string | null) => {
    if (activeDocumentId && value) setSceneMode(activeDocumentId, normalizeSceneMode(value, kind));
  };
  // Collapsed into the toolbar's More Actions menu when the bar is too narrow.
  useToolbarOverflowEntry("scene-mode", TOOLBAR_OVERFLOW_PRIORITY.sceneMode, [{
    type: "submenu",
    id: "scene-mode",
    label: "Scene Mode",
    disabled,
    items: [{
      type: "radio-group",
      id: "scene-mode-options",
      value: sceneMode,
      closeOnClick: true,
      onValueChange: chooseMode,
      items: modes.map((mode) => ({ id: `scene-mode-${mode}`, value: mode, label: SCENE_MODE_LABELS[mode] })),
    }],
  }]);
  return (
    <Select
      value={sceneMode}
      items={modes.map((value) => ({ value, label: SCENE_MODE_LABELS[value] }))}
      disabled={disabled}
      onValueChange={chooseMode}
    >
      <SelectTrigger size="sm" aria-label="Scene Mode" data-testid="scene-mode-select" className="chrome-action-button aria-expanded:bg-accent aria-expanded:text-accent-foreground">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {modes.map((mode) => <SelectItem key={mode} value={mode}>{SCENE_MODE_LABELS[mode]}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@babylonslate/ui/components/select";
import { useActiveDocumentState, useDocumentActions } from "../context/document-context";
import { SCENE_MODES, SCENE_MODE_LABELS, normalizeSceneMode } from "../shell/scene-document-layout";

export function SceneModeSelect({ disabled = false }: { disabled?: boolean }) {
  const { setSceneMode } = useDocumentActions();
  const { sceneMode, activeDocumentId } = useActiveDocumentState();
  return (
    <Select
      value={sceneMode}
      items={SCENE_MODES.map((value) => ({ value, label: SCENE_MODE_LABELS[value] }))}
      disabled={disabled}
      onValueChange={(value) => {
        if (activeDocumentId && value) setSceneMode(activeDocumentId, normalizeSceneMode(value));
      }}
    >
      <SelectTrigger size="sm" aria-label="Scene Mode" data-testid="scene-mode-select" className="chrome-action-button">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {SCENE_MODES.map((mode) => <SelectItem key={mode} value={mode}>{SCENE_MODE_LABELS[mode]}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

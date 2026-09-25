import { useEffect, useMemo, useState } from "react";
import { RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  chordFromEvent,
  isApplePlatform,
  ShortcutKeys,
  type KeyChord,
} from "@babylonslate/editor-kit";
import type { EngineSettings } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import {
  EDITOR_COMMAND_CATEGORIES,
  EDITOR_COMMANDS,
  editorCommand,
  keybindConflicts,
  resolveKeybinds,
  withKeybindOverride,
  type EditorCommandId,
} from "../lib/editor-keybinds";

/** Keys the viewport already uses for WASD fly while nothing is focused. */
const VIEWPORT_FLY_CHORDS = new Set<KeyChord>(["W", "A", "S", "D"]);

function conflictMessage(
  bindings: ReturnType<typeof resolveKeybinds>,
  commandId: EditorCommandId,
): string | null {
  const chords = bindings.get(commandId) ?? [];
  const others = new Set<string>();
  for (const chord of chords) {
    for (const id of keybindConflicts(bindings, commandId, chord)) {
      others.add(editorCommand(id)?.label ?? id);
    }
    if (commandId.startsWith("viewport.") && VIEWPORT_FLY_CHORDS.has(chord)) {
      others.add("Viewport Fly");
    }
  }
  return others.size ? `Also used by ${[...others].join(", ")}.` : null;
}

export function KeybindSettings({
  settings,
  onChange,
}: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
}) {
  const overrides = settings.keybinds;
  const bindings = useMemo(() => resolveKeybinds(overrides), [overrides]);
  const [recording, setRecording] = useState<EditorCommandId | null>(null);

  const assign = (commandId: EditorCommandId, chords: KeyChord[] | null) =>
    void onChange({ keybinds: withKeybindOverride(overrides, commandId, chords) });

  useEffect(() => {
    if (!recording) return;
    const apple = isApplePlatform();
    // Capture before the dialog so Escape cancels recording instead of closing it.
    const capture = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setRecording(null);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event, apple);
      if (!chord) return;
      void onChange({
        keybinds: withKeybindOverride(overrides, recording, [chord]),
      });
      setRecording(null);
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", capture, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("blur", cancel);
    };
  }, [recording, overrides, onChange]);

  const customized = Object.keys(overrides).length > 0;

  return (
    <>
      <Field orientation="horizontal" className="justify-between">
        <FieldDescription>
          Select a shortcut, then press the new keys. Escape cancels.
        </FieldDescription>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!customized}
          data-testid="keybinds-reset-all"
          onClick={() => void onChange({ keybinds: {} })}
        >
          <RotateCcwIcon data-icon="inline-start" />
          Reset All
        </Button>
      </Field>
      {EDITOR_COMMAND_CATEGORIES.map((category) => (
        <FieldSet key={category} data-testid={`keybinds-${category.toLowerCase()}`}>
          <FieldLegend>{category}</FieldLegend>
          {EDITOR_COMMANDS.filter((command) => command.category === category).map(
            (command) => {
              const chords = bindings.get(command.id) ?? [];
              const listening = recording === command.id;
              const overridden = command.id in overrides;
              const conflict = conflictMessage(bindings, command.id);
              const labelId = `keybind-${command.id}`;
              return (
                <Field
                  key={command.id}
                  className="settings-field"
                  data-testid={`keybind-row-${command.id}`}
                >
                  <FieldLabel id={labelId}>{command.label}</FieldLabel>
                  <div className="flex min-w-0 items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant={listening ? "secondary" : "outline"}
                      size="sm"
                      id={`${labelId}-record`}
                      aria-labelledby={`${labelId} ${labelId}-value`}
                      aria-pressed={listening}
                      data-testid={`keybind-record-${command.id}`}
                      className="min-w-32 justify-end"
                      onClick={() => setRecording(listening ? null : command.id)}
                    >
                      <span id={`${labelId}-value`} className="flex items-center gap-1.5">
                        {listening ? (
                          <span aria-live="polite">Press Keys…</span>
                        ) : chords.length ? (
                          chords.map((chord, index) => (
                            <span key={chord} className="flex items-center gap-1.5">
                              {index > 0 ? (
                                <span className="text-xs text-muted-foreground">or</span>
                              ) : null}
                              <ShortcutKeys chord={chord} />
                            </span>
                          ))
                        ) : (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
                      </span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Unassign ${command.label}`}
                            disabled={chords.length === 0}
                            data-testid={`keybind-clear-${command.id}`}
                            onClick={() => assign(command.id, [])}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipContent>Unassign</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Reset ${command.label}`}
                            disabled={!overridden}
                            data-testid={`keybind-reset-${command.id}`}
                            onClick={() => assign(command.id, null)}
                          />
                        }
                      >
                        <RotateCcwIcon />
                      </TooltipTrigger>
                      <TooltipContent>Reset to Default</TooltipContent>
                    </Tooltip>
                  </div>
                  {conflict ? (
                    <FieldDescription
                      className="flex items-center gap-1.5 text-destructive"
                      data-testid={`keybind-conflict-${command.id}`}
                    >
                      <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      {conflict}
                    </FieldDescription>
                  ) : null}
                </Field>
              );
            },
          )}
        </FieldSet>
      ))}
    </>
  );
}

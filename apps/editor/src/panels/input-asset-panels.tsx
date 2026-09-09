import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  normalizeInputAssetPayload,
  type InputAssetPayload,
  type InputDevice,
} from "@babylonslate/core";
import {
  BindingCodePicker,
  PanelFrame,
  PropertyGrid,
  SearchDropdown,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useInputAssetEditing } from "../context/input-asset-editing-context";

type Binding = InputAssetPayload["bindings"][number];
const DEVICES: Array<{ id: InputDevice; label: string }> = [
  { id: "key", label: "Keyboard" },
  { id: "mouseButton", label: "Mouse Button" },
  { id: "gamepadButton", label: "Gamepad Button" },
  { id: "gamepadAxis", label: "Gamepad Axis" },
  { id: "pointer", label: "Pointer Button" },
  { id: "touch", label: "Touch Control" },
];

function useInputDocument() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, activeDocumentId } =
    useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const isAxis = doc?.ref.kind === "input-axis";
  const asset = normalizeInputAssetPayload(
    isAxis ? "InputAxis" : "InputAction",
    doc?.content,
  );
  const commit = (next: InputAssetPayload) =>
    void applyAssetDocumentChange(documentId, { ...next });
  const patch = (id: string, changes: Partial<Binding>) =>
    commit({
      ...asset,
      bindings: asset.bindings.map((binding) =>
        binding.id === id ? { ...binding, ...changes } : binding,
      ),
    });
  return {
    asset,
    isAxis,
    commit,
    patch,
    active: activeDocumentId === documentId,
  };
}

export function InputBindingsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { asset, isAxis, commit, patch, active } = useInputDocument();
  const { selectedId, select } = useInputAssetEditing();
  const [listening, setListening] = useState<string | null>(null);
  useEffect(() => {
    if (!listening) return;
    if (!active) {
      setListening(null);
      return;
    }
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") {
        setListening(null);
        return;
      }
      const modifier = /^(Shift|Control|Alt|Meta)/.test(event.code);
      if (modifier && event.type === "keydown") return;
      if (!modifier && event.type === "keyup") return;
      patch(listening, {
        code: event.code,
        modifiers: {
          shift: event.shiftKey && !event.code.startsWith("Shift"),
          ctrl: event.ctrlKey && !event.code.startsWith("Control"),
          alt: event.altKey && !event.code.startsWith("Alt"),
          meta: event.metaKey && !event.code.startsWith("Meta"),
        },
      });
      setListening(null);
    };
    const cancel = () => setListening(null);
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keyup", capture, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keyup", capture, true);
      window.removeEventListener("blur", cancel);
    };
  }, [listening, patch, active]);
  const append = (bindings: Array<Omit<Binding, "id">>) => {
    const added = bindings.map((binding) => ({
      ...binding,
      id: crypto.randomUUID(),
    }));
    commit({ ...asset, bindings: [...asset.bindings, ...added] });
    select(added[0]?.id ?? null);
  };
  return (
    <PanelFrame
      className="input-asset-editor"
      data-testid="input-bindings-panel"
      toolbar={
        <>
          <SearchDropdown
            title="Add Control"
            items={DEVICES}
            onSelect={(device) =>
              append([
                {
                  device: device as InputDevice,
                  code: "",
                  ...(isAxis ? { scale: 1 } : {}),
                },
              ])
            }
          >
            <Button size="sm" variant="outline">
              Add Control
            </Button>
          </SearchDropdown>
          {isAxis && (
            <SearchDropdown
              title="Add Preset"
              items={[
                {
                  id: "wasd",
                  label: "WASD",
                  description: "Two-dimensional keyboard movement",
                },
                {
                  id: "arrows",
                  label: "Arrow Keys",
                  description: "Two-dimensional keyboard movement",
                },
                { id: "left", label: "Left Stick" },
                { id: "right", label: "Right Stick" },
              ]}
              onSelect={(preset) => {
                const keys =
                  preset === "wasd"
                    ? ["KeyA", "KeyD", "KeyS", "KeyW"]
                    : ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"];
                const bindings: Binding[] =
                  preset === "left" || preset === "right"
                    ? [0, 1].map((index) => ({
                        id: crypto.randomUUID(),
                        device: "gamepadAxis",
                        code: `0:${(preset === "right" ? 2 : 0) + index}`,
                        component: index === 0 ? "x" : "y",
                        deadZone: 0.15,
                        invert: index === 1,
                      }))
                    : keys.map((code, index) => ({
                        id: crypto.randomUUID(),
                        device: "key",
                        code,
                        component: index < 2 ? "x" : "y",
                        digitalValue: index % 2 === 0 ? -1 : 1,
                      }));
                commit({
                  ...asset,
                  valueType: "2d",
                  bindings: [...asset.bindings, ...bindings],
                });
                select(bindings[0]?.id ?? null);
              }}
            >
              <Button size="sm" variant="outline">
                Add Preset
              </Button>
            </SearchDropdown>
          )}
        </>
      }
    >
      <div className="input-asset-editor space-y-3 p-3">
        <p className="text-sm text-muted-foreground">
          {isAxis
            ? "Combine controls into a movement value. Use the matching input event in your graph."
            : "Any control below can trigger this action. Add its input event to your graph."}
        </p>
        {isAxis && (
          <PropertyGrid
            rows={[
              {
                id: "dimensions",
                kind: "enum",
                label: "Value",
                value: asset.valueType,
                options: [
                  { value: "1d", label: "1D · Number" },
                  { value: "2d", label: "2D · X and Y" },
                ],
                onChange: (value) =>
                  commit({ ...asset, valueType: value === "2d" ? "2d" : "1d" }),
              },
            ]}
          />
        )}
        {asset.bindings.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Controls</EmptyTitle>
              <EmptyDescription>
                Add a keyboard, mouse, gamepad, or touch control
                {isAxis ? ", or start with a preset" : ""}.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {asset.bindings.map((binding, index) => (
              <div
                key={binding.id}
                className={`flex flex-wrap items-center gap-2 p-2 ${selectedId === binding.id ? "bg-accent" : index % 2 ? "bg-[var(--list-stripe)]" : ""}`}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={selectedId === binding.id}
                  onClick={() => select(binding.id)}
                >
                  {
                    DEVICES.find((device) => device.id === binding.device)
                      ?.label
                  }
                </Button>
                <BindingCodePicker
                  size="sm"
                  device={binding.device}
                  code={binding.code}
                  onChange={(code) => patch(binding.id, { code })}
                  data-testid={`input-control-${binding.id}`}
                />
                {binding.device === "key" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      select(binding.id);
                      setListening(
                        listening === binding.id ? null : binding.id,
                      );
                    }}
                  >
                    {listening === binding.id
                      ? "Press a Key · Esc Cancels"
                      : "Listen"}
                  </Button>
                )}
                {isAxis && (
                  <span className="text-xs text-muted-foreground">
                    {asset.valueType === "2d"
                      ? (binding.component ?? "x").toUpperCase()
                      : "Value"}{" "}
                    ·{" "}
                    {(binding.digitalValue ?? binding.scale ?? 1) < 0
                      ? "Negative"
                      : "Positive"}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => select(binding.id)}
                >
                  Details
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove control ${index + 1}`}
                  onClick={() => {
                    commit({
                      ...asset,
                      bindings: asset.bindings.filter(
                        (entry) => entry.id !== binding.id,
                      ),
                    });
                    if (selectedId === binding.id) select(null);
                    if (listening === binding.id) setListening(null);
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        <p role="status" className="text-xs text-muted-foreground">
          {listening
            ? "Press a key or key combination. Escape or leaving this window cancels."
            : "Select Details to adjust a control. Changes use the document’s normal save and undo commands."}
        </p>
      </div>
    </PanelFrame>
  );
}

export function InputBindingDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { asset, isAxis, patch } = useInputDocument();
  const { selectedId } = useInputAssetEditing();
  const binding = asset.bindings.find((entry) => entry.id === selectedId);
  if (!binding)
    return (
      <PanelFrame>
        <p className="p-3 text-sm text-muted-foreground">
          Select a control in Bindings to edit its details.
        </p>
      </PanelFrame>
    );
  const rows: PropertyRow[] = [];
  if (binding.device === "key")
    for (const modifier of ["shift", "ctrl", "alt", "meta"] as const)
      rows.push({
        id: modifier,
        kind: "boolean",
        label: `${modifier === "ctrl" ? "Control" : modifier === "meta" ? "Command / Windows" : modifier[0].toUpperCase() + modifier.slice(1)} Required`,
        value: !!binding.modifiers?.[modifier],
        onChange: (value) =>
          patch(binding.id, {
            modifiers: { ...binding.modifiers, [modifier]: value },
          }),
      });
  if (isAxis) {
    if (asset.valueType === "2d")
      rows.push({
        id: "component",
        kind: "enum",
        label: "Direction",
        value: binding.component ?? "x",
        options: [
          { value: "x", label: "X · Horizontal" },
          { value: "y", label: "Y · Vertical" },
        ],
        onChange: (value) =>
          patch(binding.id, { component: value === "y" ? "y" : "x" }),
      });
    const digital =
      binding.device === "key" ||
      binding.device === "mouseButton" ||
      binding.device === "gamepadButton";
    rows.push({
      id: "scale",
      kind: "number",
      label: digital ? "Value When Held" : "Scale",
      value: digital ? (binding.digitalValue ?? 1) : (binding.scale ?? 1),
      onChange: (value) =>
        patch(binding.id, digital ? { digitalValue: value } : { scale: value }),
    });
    if (!digital)
      rows.push(
        {
          id: "deadZone",
          kind: "number",
          label: "Dead Zone",
          value: binding.deadZone ?? 0,
          min: 0,
          max: 1,
          onChange: (value) => patch(binding.id, { deadZone: value }),
        },
        {
          id: "sensitivity",
          kind: "number",
          label: "Sensitivity",
          value: binding.sensitivity ?? 1,
          onChange: (value) => patch(binding.id, { sensitivity: value }),
        },
      );
    rows.push({
      id: "invert",
      kind: "boolean",
      label: "Invert",
      value: !!binding.invert,
      onChange: (value) => patch(binding.id, { invert: value }),
    });
  }
  return (
    <PanelFrame data-testid="input-details-panel">
      <div className="input-asset-editor space-y-3 p-3">
        <PropertyGrid rows={rows} />
        {!rows.length && (
          <p className="text-sm text-muted-foreground">
            This control needs no additional settings.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {isAxis
            ? "Negative values move in the opposite direction. Dead zone ignores small stick movements."
            : "Controls are alternatives: holding any one keeps the action active."}
        </p>
      </div>
    </PanelFrame>
  );
}

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type {
  ActionBinding,
  ActionMapping,
  AxisBinding,
  AxisMapping,
  InputDevice,
  InputMappings,
} from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { BindingCaptureButton } from "./binding-capture-button";
import { NumericDragField } from "./numeric-drag-field";

export const DEFAULT_TOUCH_CONTROL_IDS = [
  "joystick-x",
  "joystick-y",
  "dpad-x",
  "dpad-y",
] as const;

export const INPUT_DEVICES: Array<{ value: InputDevice; label: string }> = [
  { value: "key", label: "Key" },
  { value: "mouseButton", label: "Mouse" },
  { value: "pointer", label: "Pointer" },
  { value: "gamepadButton", label: "Pad Button" },
  { value: "gamepadAxis", label: "Pad Axis" },
  { value: "touch", label: "Touch" },
];

export interface InputMappingEditorProps {
  value: InputMappings;
  onChange: (next: InputMappings) => void;
  touchControlIds?: readonly string[];
  "data-testid"?: string;
}

function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

function patchAction(
  value: InputMappings,
  index: number,
  patch: Partial<ActionMapping>,
): InputMappings {
  const actions = [...value.actions];
  actions[index] = { ...actions[index]!, ...patch };
  return { ...value, actions };
}

function patchAxis(
  value: InputMappings,
  index: number,
  patch: Partial<AxisMapping>,
): InputMappings {
  const axes = [...value.axes];
  axes[index] = { ...axes[index]!, ...patch };
  return { ...value, axes };
}

function DevicePicker({
  id,
  device,
  onChange,
}: {
  id: string;
  device: InputDevice;
  onChange: (device: InputDevice) => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="touch"
      spacing={1}
      value={[device]}
      onValueChange={(next) => {
        const picked = next[0] as InputDevice | undefined;
        if (!picked) return;
        onChange(picked);
      }}
      aria-label="Device"
    >
      {INPUT_DEVICES.map((entry) => (
        <ToggleGroupItem
          key={entry.value}
          value={entry.value}
          aria-label={entry.label}
          data-testid={`${id}-device-${entry.value}`}
        >
          {entry.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function BindingChrome({
  id,
  index,
  total,
  onMove,
  onRemove,
  name,
}: {
  id: string;
  index: number;
  total: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
  name: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="touch-icon"
        aria-label={`Move ${name} up`}
        data-testid={`${id}-move-up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="touch-icon"
        aria-label={`Move ${name} down`}
        data-testid={`${id}-move-down`}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        aria-label={`Remove ${name}`}
        data-testid={`${id}-remove`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </div>
  );
}

function TouchControlPicker({
  id,
  code,
  options,
  onChange,
}: {
  id: string;
  code: string;
  options: readonly string[];
  onChange: (code: string) => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="touch"
      spacing={1}
      value={code ? [code] : []}
      onValueChange={(next) => {
        const picked = next[0];
        if (!picked) return;
        onChange(picked);
      }}
      aria-label="Touch Control"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          data-testid={`${id}-touch-${option}`}
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function ActionBindingRow({
  id,
  binding,
  index,
  total,
  touchControlIds,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  binding: ActionBinding;
  index: number;
  total: number;
  touchControlIds: readonly string[];
  onChange: (next: ActionBinding) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <FieldGroup className="rounded-md border border-border p-2">
      <DevicePicker
        id={id}
        device={binding.device}
        onChange={(device) => onChange({ ...binding, device, code: "" })}
      />
      {binding.device === "touch" ? (
        <TouchControlPicker
          id={id}
          code={binding.code}
          options={touchControlIds}
          onChange={(code) => onChange({ ...binding, code })}
        />
      ) : (
        <BindingCaptureButton
          device={binding.device}
          code={binding.code}
          modifiers={binding.modifiers}
          onCapture={(next) =>
            onChange({
              ...binding,
              code: next.code,
              modifiers: next.modifiers,
            })
          }
          data-testid={`${id}-listen`}
        />
      )}
      <BindingChrome
        id={id}
        index={index}
        total={total}
        onMove={onMove}
        onRemove={onRemove}
        name={`binding ${index + 1}`}
      />
    </FieldGroup>
  );
}

function AxisBindingRow({
  id,
  binding,
  index,
  total,
  kind,
  touchControlIds,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  binding: AxisBinding;
  index: number;
  total: number;
  kind: "1d" | "2d";
  touchControlIds: readonly string[];
  onChange: (next: AxisBinding) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <FieldGroup className="rounded-md border border-border p-2">
      <DevicePicker
        id={id}
        device={binding.device}
        onChange={(device) => onChange({ ...binding, device, code: "" })}
      />
      {binding.device === "touch" ? (
        <TouchControlPicker
          id={id}
          code={binding.code}
          options={touchControlIds}
          onChange={(code) => onChange({ ...binding, code })}
        />
      ) : (
        <BindingCaptureButton
          device={binding.device}
          code={binding.code}
          modifiers={binding.modifiers}
          onCapture={(next) =>
            onChange({
              ...binding,
              code: next.code,
              modifiers: next.modifiers,
            })
          }
          data-testid={`${id}-listen`}
        />
      )}
      {kind === "2d" ? (
        <Field>
          <FieldLabel>Component</FieldLabel>
          <ToggleGroup
            variant="outline"
            size="touch"
            spacing={1}
            value={binding.component ? [binding.component] : []}
            onValueChange={(next) => {
              const component = next[0];
              if (component !== "x" && component !== "y") return;
              onChange({ ...binding, component });
            }}
            aria-label="Axis Component"
          >
            <ToggleGroupItem value="x" data-testid={`${id}-component-x`}>
              X
            </ToggleGroupItem>
            <ToggleGroupItem value="y" data-testid={`${id}-component-y`}>
              Y
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      ) : null}
      <Field orientation="horizontal">
        <Switch
          id={`${id}-invert`}
          checked={binding.invert === true}
          onCheckedChange={(checked) =>
            onChange({ ...binding, invert: checked === true })
          }
          data-testid={`${id}-invert`}
        />
        <FieldLabel htmlFor={`${id}-invert`}>Invert</FieldLabel>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <NumericDragField
          label="DZ"
          value={binding.deadZone ?? 0}
          min={0}
          max={1}
          sensitivity={0.005}
          onChange={(deadZone) => onChange({ ...binding, deadZone })}
          data-testid={`${id}-dead-zone`}
        />
        <NumericDragField
          label="Scale"
          value={binding.scale ?? 1}
          sensitivity={0.01}
          onChange={(scale) => onChange({ ...binding, scale })}
          data-testid={`${id}-scale`}
        />
        <NumericDragField
          label="Sens"
          value={binding.sensitivity ?? 1}
          sensitivity={0.01}
          onChange={(sensitivity) => onChange({ ...binding, sensitivity })}
          data-testid={`${id}-sensitivity`}
        />
        <NumericDragField
          label="Dig"
          value={binding.digitalValue ?? 0}
          min={-1}
          max={1}
          sensitivity={0.01}
          onChange={(digitalValue) => onChange({ ...binding, digitalValue })}
          data-testid={`${id}-digital-value`}
        />
      </div>
      <BindingChrome
        id={id}
        index={index}
        total={total}
        onMove={onMove}
        onRemove={onRemove}
        name={`binding ${index + 1}`}
      />
    </FieldGroup>
  );
}

/** Touch-first action / axis mapping editor for Project Settings. */
export function InputMappingEditor({
  value,
  onChange,
  touchControlIds = DEFAULT_TOUCH_CONTROL_IDS,
  "data-testid": testId,
}: InputMappingEditorProps) {
  return (
    <div className="flex flex-col gap-4" data-testid={testId ?? "input-mapping-editor"}>
      <FieldSet>
        <FieldLegend>Actions</FieldLegend>
        <div className="flex flex-col gap-3">
          {value.actions.map((action, index) => {
            const actionId = `input-action-${index}`;
            return (
              <FieldGroup
                key={`${action.name}-${index}`}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-end gap-2">
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${actionId}-name`}>Name</FieldLabel>
                    <Input
                      id={`${actionId}-name`}
                      className="min-h-[var(--touch-target,44px)]"
                      value={action.name}
                      onChange={(event) =>
                        onChange(
                          patchAction(value, index, { name: event.target.value }),
                        )
                      }
                      data-testid={`${actionId}-name`}
                    />
                  </Field>
                  <BindingChrome
                    id={actionId}
                    index={index}
                    total={value.actions.length}
                    onMove={(delta) =>
                      onChange({
                        ...value,
                        actions: moveItem(value.actions, index, delta),
                      })
                    }
                    onRemove={() =>
                      onChange({
                        ...value,
                        actions: value.actions.filter((_, i) => i !== index),
                      })
                    }
                    name={action.name || "action"}
                  />
                </div>
                {action.bindings.map((binding, bindingIndex) => (
                  <ActionBindingRow
                    key={`${actionId}-binding-${bindingIndex}`}
                    id={`${actionId}-binding-${bindingIndex}`}
                    binding={binding}
                    index={bindingIndex}
                    total={action.bindings.length}
                    touchControlIds={touchControlIds}
                    onChange={(next) => {
                      const bindings = [...action.bindings];
                      bindings[bindingIndex] = next;
                      onChange(patchAction(value, index, { bindings }));
                    }}
                    onMove={(delta) =>
                      onChange(
                        patchAction(value, index, {
                          bindings: moveItem(action.bindings, bindingIndex, delta),
                        }),
                      )
                    }
                    onRemove={() =>
                      onChange(
                        patchAction(value, index, {
                          bindings: action.bindings.filter(
                            (_, i) => i !== bindingIndex,
                          ),
                        }),
                      )
                    }
                  />
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  data-testid={`${actionId}-add-binding`}
                  onClick={() =>
                    onChange(
                      patchAction(value, index, {
                        bindings: [
                          ...action.bindings,
                          { device: "key", code: "" },
                        ],
                      }),
                    )
                  }
                >
                  Add Binding
                </Button>
              </FieldGroup>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-fit"
            data-testid="input-action-add"
            onClick={() =>
              onChange({
                ...value,
                actions: [
                  ...value.actions,
                  { name: "New Action", bindings: [] },
                ],
              })
            }
          >
            Add Action
          </Button>
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Axes</FieldLegend>
        <div className="flex flex-col gap-3">
          {value.axes.map((axis, index) => {
            const axisId = `input-axis-${index}`;
            const kind = axis.kind === "2d" ? "2d" : "1d";
            return (
              <FieldGroup
                key={`${axis.name}-${index}`}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-end gap-2">
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${axisId}-name`}>Name</FieldLabel>
                    <Input
                      id={`${axisId}-name`}
                      className="min-h-[var(--touch-target,44px)]"
                      value={axis.name}
                      onChange={(event) =>
                        onChange(
                          patchAxis(value, index, { name: event.target.value }),
                        )
                      }
                      data-testid={`${axisId}-name`}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Kind</FieldLabel>
                    <ToggleGroup
                      variant="outline"
                      size="touch"
                      spacing={1}
                      value={[kind]}
                      onValueChange={(next) => {
                        const picked = next[0];
                        if (picked !== "1d" && picked !== "2d") return;
                        onChange(patchAxis(value, index, { kind: picked }));
                      }}
                      aria-label="Axis Kind"
                    >
                      <ToggleGroupItem value="1d" data-testid={`${axisId}-kind-1d`}>
                        1D
                      </ToggleGroupItem>
                      <ToggleGroupItem value="2d" data-testid={`${axisId}-kind-2d`}>
                        2D
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                  <BindingChrome
                    id={axisId}
                    index={index}
                    total={value.axes.length}
                    onMove={(delta) =>
                      onChange({
                        ...value,
                        axes: moveItem(value.axes, index, delta),
                      })
                    }
                    onRemove={() =>
                      onChange({
                        ...value,
                        axes: value.axes.filter((_, i) => i !== index),
                      })
                    }
                    name={axis.name || "axis"}
                  />
                </div>
                {axis.bindings.map((binding, bindingIndex) => (
                  <AxisBindingRow
                    key={`${axisId}-binding-${bindingIndex}`}
                    id={`${axisId}-binding-${bindingIndex}`}
                    binding={binding}
                    index={bindingIndex}
                    total={axis.bindings.length}
                    kind={kind}
                    touchControlIds={touchControlIds}
                    onChange={(next) => {
                      const bindings = [...axis.bindings];
                      bindings[bindingIndex] = next;
                      onChange(patchAxis(value, index, { bindings }));
                    }}
                    onMove={(delta) =>
                      onChange(
                        patchAxis(value, index, {
                          bindings: moveItem(axis.bindings, bindingIndex, delta),
                        }),
                      )
                    }
                    onRemove={() =>
                      onChange(
                        patchAxis(value, index, {
                          bindings: axis.bindings.filter(
                            (_, i) => i !== bindingIndex,
                          ),
                        }),
                      )
                    }
                  />
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  data-testid={`${axisId}-add-binding`}
                  onClick={() =>
                    onChange(
                      patchAxis(value, index, {
                        bindings: [
                          ...axis.bindings,
                          { device: "key", code: "", digitalValue: 1 },
                        ],
                      }),
                    )
                  }
                >
                  Add Binding
                </Button>
              </FieldGroup>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-fit"
            data-testid="input-axis-add"
            onClick={() =>
              onChange({
                ...value,
                axes: [
                  ...value.axes,
                  { name: "New Axis", kind: "1d", bindings: [] },
                ],
              })
            }
          >
            Add Axis
          </Button>
        </div>
      </FieldSet>
    </div>
  );
}

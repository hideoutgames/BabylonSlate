import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, Trash2Icon } from "lucide-react";
import type {
  ActionBinding,
  ActionMapping,
  AxisBinding,
  AxisMapping,
  BindingModifiers,
  InputDevice,
  InputMappings,
} from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@babylonslate/ui/components/card";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldError,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Switch } from "@babylonslate/ui/components/switch";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@babylonslate/ui/components/empty";
import { SearchInput } from "./search-input";
import { formatBindingLabel } from "./format-binding-label";
import { BindingCodePicker } from "./binding-code-picker";
import { NumberField, type NumberFieldProps } from "./number-field";

export const INPUT_DEVICES: Array<{ value: InputDevice; label: string }> = [
  { value: "key", label: "Key" },
  { value: "mouseButton", label: "Mouse" },
  { value: "gamepadButton", label: "Gamepad Button" },
  { value: "gamepadAxis", label: "Gamepad Axis" },
];

const MODIFIER_TOGGLES: Array<{ key: keyof BindingModifiers; label: string }> =
  [
    { key: "ctrl", label: "Ctrl" },
    { key: "shift", label: "Shift" },
    { key: "alt", label: "Alt" },
    { key: "meta", label: "Meta" },
  ];

export interface InputMappingEditorProps {
  value: InputMappings;
  onChange: (next: InputMappings) => void;
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

function isAnalogBinding(device: InputDevice): boolean {
  return device === "gamepadAxis";
}

function showsModifiers(device: InputDevice): boolean {
  return device === "key" || device === "mouseButton";
}

function patchModifiers(
  current: BindingModifiers | undefined,
  key: keyof BindingModifiers,
  on: boolean,
): BindingModifiers | undefined {
  const next: BindingModifiers = { ...current };
  if (on) next[key] = true;
  else delete next[key];
  return Object.values(next).some(Boolean) ? next : undefined;
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
  const selected =
    INPUT_DEVICES.find((entry) => entry.value === device)?.label ?? "Key";
  return (
    <Select
      value={device}
      onValueChange={(next) => {
        const picked = next as InputDevice | null;
        if (!picked) return;
        onChange(picked);
      }}
    >
      <SelectTrigger
        id={`${id}-device`}
        className="w-full"
        aria-label="Device"
        data-testid={`${id}-device`}
      >
        <SelectValue>{() => selected}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {INPUT_DEVICES.map((entry) => (
            <SelectItem
              key={entry.value}
              value={entry.value}
              data-testid={`${id}-device-${entry.value}`}
            >
              {entry.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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
    <div className="flex shrink-0 items-center gap-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
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
        size="icon-sm"
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
        size="icon-sm"
        aria-label={`Remove ${name}`}
        data-testid={`${id}-remove`}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

function ModifierToggles({
  id,
  modifiers,
  onChange,
}: {
  id: string;
  modifiers?: BindingModifiers;
  onChange: (next?: BindingModifiers) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`${id}-modifiers`}>
      <p className="text-sm font-medium">Modifiers</p>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Modifiers">
        {MODIFIER_TOGGLES.map((entry) => (
          <Toggle
            key={entry.key}
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            pressed={modifiers?.[entry.key] === true}
            aria-label={entry.label}
            data-testid={`${id}-mod-${entry.key}`}
            onPressedChange={(pressed) =>
              onChange(patchModifiers(modifiers, entry.key, pressed))
            }
          >
            {entry.label}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

function ActionBindingRow({
  id,
  binding,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  binding: ActionBinding;
  index: number;
  total: number;
  onChange: (next: ActionBinding) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2 even:bg-list-stripe"
      data-testid={id}
      data-device={binding.device}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-32 flex-1">
          <FieldLabel htmlFor={`${id}-device`}>Device</FieldLabel>
          <DevicePicker
            id={id}
            device={binding.device}
            onChange={(device) => onChange({ device, code: "" })}
          />
        </Field>
        <Field className="min-w-40 flex-[2]">
          <FieldLabel htmlFor={`${id}-code`}>Control</FieldLabel>
          <BindingCodePicker
            size="sm"
            device={binding.device}
            code={binding.code}
            onChange={(code) => onChange({ ...binding, code })}
            data-testid={`${id}-code`}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={optionsOpen}
          aria-controls={`${id}-options-body`}
          data-testid={`${id}-options`}
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          Options
        </Button>
        <BindingChrome
          id={id}
          index={index}
          total={total}
          onMove={onMove}
          onRemove={onRemove}
          name={`binding ${index + 1}`}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {binding.code
          ? formatBindingLabel(binding.device, binding.code, binding.modifiers)
          : "Choose a control to finish this binding."}
      </p>
      {optionsOpen ? (
        <FieldGroup id={`${id}-options-body`} className="gap-3">
          {showsModifiers(binding.device) ? (
            <ModifierToggles
              id={id}
              modifiers={binding.modifiers}
              onChange={(modifiers) => onChange({ ...binding, modifiers })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No additional options for this device.
            </p>
          )}
        </FieldGroup>
      ) : null}
    </div>
  );
}

function AxisNumber({
  label,
  "data-testid": testId,
  ...props
}: NumberFieldProps & { label: string; "data-testid": string }) {
  return (
    <Field>
      <FieldLabel htmlFor={testId}>{label}</FieldLabel>
      <NumberField {...props} id={testId} data-testid={testId} />
    </Field>
  );
}

function axisBindingSummary(binding: AxisBinding, kind: "1d" | "2d"): string {
  const parts = [
    formatBindingLabel(binding.device, binding.code, binding.modifiers),
  ];
  if (kind === "2d") parts.push((binding.component ?? "x").toUpperCase());
  if (!isAnalogBinding(binding.device)) {
    const value = binding.digitalValue ?? 1;
    parts.push(`Held ${value > 0 ? "+" : ""}${value}`);
  }
  if (binding.invert) parts.push("Inverted");
  return parts.join(" / ");
}

function AxisBindingRow({
  id,
  binding,
  index,
  total,
  kind,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  binding: AxisBinding;
  index: number;
  total: number;
  kind: "1d" | "2d";
  onChange: (next: AxisBinding) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const analog = isAnalogBinding(binding.device);
  const [optionsOpen, setOptionsOpen] = useState(false);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2 even:bg-list-stripe"
      data-testid={id}
      data-device={binding.device}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-32 flex-1">
          <FieldLabel htmlFor={`${id}-device`}>Device</FieldLabel>
          <DevicePicker
            id={id}
            device={binding.device}
            onChange={(device) =>
              onChange({ device, code: "", component: binding.component })
            }
          />
        </Field>
        <Field className="min-w-40 flex-[2]">
          <FieldLabel htmlFor={`${id}-code`}>Control</FieldLabel>
          <BindingCodePicker
            size="sm"
            device={binding.device}
            code={binding.code}
            onChange={(code) => onChange({ ...binding, code })}
            data-testid={`${id}-code`}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={optionsOpen}
          aria-controls={`${id}-options-body`}
          data-testid={`${id}-options`}
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          Options
        </Button>
        <BindingChrome
          id={id}
          index={index}
          total={total}
          onMove={onMove}
          onRemove={onRemove}
          name={`binding ${index + 1}`}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {binding.code
          ? axisBindingSummary(binding, kind)
          : "Choose a control to finish this binding."}
      </p>
      {optionsOpen ? (
        <FieldGroup id={`${id}-options-body`} className="gap-3">
          {showsModifiers(binding.device) ? (
            <ModifierToggles
              id={id}
              modifiers={binding.modifiers}
              onChange={(modifiers) => onChange({ ...binding, modifiers })}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {kind === "2d" ? (
              <ToggleGroup
                variant="outline"
                size="sm"
                className="pointer-coarse:[&>button]:min-h-11 pointer-coarse:[&>button]:min-w-11"
                spacing={1}
                value={binding.component ? [binding.component] : []}
                onValueChange={(next) => {
                  const component = next[0];
                  if (component !== "x" && component !== "y") return;
                  onChange({ ...binding, component });
                }}
                aria-label="Axis Component"
              >
                <ToggleGroupItem
                  value="x"
                  className="text-axis-x"
                  data-testid={`${id}-component-x`}
                >
                  X
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="y"
                  className="text-axis-y"
                  data-testid={`${id}-component-y`}
                >
                  Y
                </ToggleGroupItem>
              </ToggleGroup>
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
          </div>
          {analog ? (
            <FieldGroup className="grid grid-cols-1 gap-2 @sm/input:grid-cols-3">
              <AxisNumber
                label="Dead Zone"
                value={binding.deadZone ?? 0}
                min={0}
                max={1}
                onChange={(deadZone) => onChange({ ...binding, deadZone })}
                data-testid={`${id}-dead-zone`}
              />
              <AxisNumber
                label="Scale"
                value={binding.scale ?? 1}
                onChange={(scale) => onChange({ ...binding, scale })}
                data-testid={`${id}-scale`}
              />
              <AxisNumber
                label="Sensitivity"
                value={binding.sensitivity ?? 1}
                onChange={(sensitivity) =>
                  onChange({ ...binding, sensitivity })
                }
                data-testid={`${id}-sensitivity`}
              />
            </FieldGroup>
          ) : (
            <AxisNumber
              label="Value When Held"
              value={binding.digitalValue ?? 1}
              min={-1}
              max={1}
              onChange={(digitalValue) =>
                onChange({ ...binding, digitalValue })
              }
              data-testid={`${id}-digital-value`}
            />
          )}
        </FieldGroup>
      ) : null}
    </div>
  );
}

function MappingNameField({
  id,
  name,
  names,
  onChange,
}: {
  id: string;
  name: string;
  names: string[];
  onChange: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const trimmed = draft.trim();
  const error = !trimmed
    ? "Enter a mapping name."
    : names.includes(trimmed)
      ? "This name is already in use."
      : undefined;
  const commit = () => {
    if (!error && trimmed !== name) onChange(trimmed);
  };
  return (
    <Field className="min-w-32 flex-1" data-invalid={!!error}>
      <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
      <Input
        id={`${id}-name`}
        data-testid={`${id}-name`}
        value={draft}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-name-error` : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      {error ? (
        <FieldError id={`${id}-name-error`} role="alert">
          {error}
        </FieldError>
      ) : null}
    </Field>
  );
}

function availableName(base: string, names: string[]): string {
  if (!names.includes(base)) return base;
  let suffix = 2;
  while (names.includes(`${base} ${suffix}`)) suffix++;
  return `${base} ${suffix}`;
}

function bindingSummary(mapping: ActionMapping): string {
  return (
    mapping.bindings
      .map((binding) =>
        binding.code
          ? formatBindingLabel(binding.device, binding.code, binding.modifiers)
          : "Unassigned",
      )
      .join(", ") || "No Bindings"
  );
}

/** Action / axis mapping editor retained for the Component Gallery. */
export function InputMappingEditor({
  value,
  onChange,
  "data-testid": testId,
}: InputMappingEditorProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState({
    kind: value.actions.length ? "action" : "axis",
    index: 0,
  });
  const currentList = selection.kind === "action" ? value.actions : value.axes;
  const selected = currentList.length
    ? { ...selection, index: Math.min(selection.index, currentList.length - 1) }
    : { kind: value.actions.length ? "action" : "axis", index: 0 };
  const matches = (mapping: ActionMapping) =>
    `${mapping.name} ${bindingSummary(mapping)}`
      .toLowerCase()
      .includes(query.toLowerCase().trim());
  const noResults = ![...value.actions, ...value.axes].some(matches);
  return (
    <div
      className="@container/input flex flex-col gap-3"
      data-testid={testId ?? "input-mapping-editor"}
    >
      <p className="text-sm text-muted-foreground">
        Actions are buttons such as Jump. Axes describe movement or looking. Set
        project defaults here; games can override bindings at runtime.
      </p>
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 @2xl/input:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label="Input Mappings"
          className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
        >
          <SearchInput
            value={query}
            onChange={setQuery}
            aria-label="Search Mappings"
            placeholder="Search Mappings"
          />
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto @2xl/input:max-h-[32rem]">
            {(["action", "axis"] as const).map((kind) => {
              const mappings = kind === "action" ? value.actions : value.axes;
              return (
                <div key={kind} className="flex min-w-0 flex-col gap-1">
                  <p
                    className="px-2 py-1 text-sm font-medium"
                    data-testid={`input-${kind === "action" ? "actions" : "axes"}-legend`}
                  >
                    {kind === "action" ? "Actions" : "Axes"} ({mappings.length})
                  </p>
                  {mappings.map((mapping, index) =>
                    matches(mapping) ? (
                      <Button
                        key={index}
                        type="button"
                        variant={
                          selected.kind === kind && selected.index === index
                            ? "secondary"
                            : "ghost"
                        }
                        className="h-auto min-w-0 justify-start py-2"
                        aria-current={
                          selected.kind === kind && selected.index === index
                            ? "true"
                            : undefined
                        }
                        data-testid={`input-${kind}-${index}-select`}
                        onClick={() => setSelection({ kind, index })}
                      >
                        <span className="flex min-w-0 flex-col items-start gap-1 text-left">
                          <span className="max-w-full truncate">
                            {mapping.name}
                          </span>
                          <span className="max-w-full truncate text-xs text-muted-foreground">
                            {bindingSummary(mapping)}
                          </span>
                        </span>
                      </Button>
                    ) : null,
                  )}
                </div>
              );
            })}
            {noResults ? (
              <p role="status" className="p-2 text-sm text-muted-foreground">
                No Matching Mappings
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="input-action-add"
              onClick={() => {
                setQuery("");
                setSelection({ kind: "action", index: value.actions.length });
                onChange({
                  ...value,
                  actions: [
                    ...value.actions,
                    {
                      name: availableName(
                        "New Action",
                        value.actions.map((entry) => entry.name),
                      ),
                      bindings: [],
                    },
                  ],
                });
              }}
            >
              Add Action
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="input-axis-add"
              onClick={() => {
                setQuery("");
                setSelection({ kind: "axis", index: value.axes.length });
                onChange({
                  ...value,
                  axes: [
                    ...value.axes,
                    {
                      name: availableName(
                        "New Axis",
                        value.axes.map((entry) => entry.name),
                      ),
                      kind: "1d",
                      bindings: [],
                    },
                  ],
                });
              }}
            >
              Add Axis
            </Button>
          </div>
        </nav>
        <div className="min-w-0">
          {value.actions.length + value.axes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No Input Mappings</EmptyTitle>
                <EmptyDescription>
                  Add an action for buttons or an axis for movement.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <>
            <div className="flex flex-col gap-3">
              {value.actions.map((action, index) => {
                if (selected.kind !== "action" || selected.index !== index)
                  return null;
                const actionId = `input-action-${index}`;
                return (
                  <Card key={actionId} size="sm" data-testid={actionId}>
                    <CardHeader className="border-b border-border">
                      <CardTitle>Action</CardTitle>
                      <CardDescription>
                        Any bound control can trigger this action.
                      </CardDescription>
                      <div className="flex flex-wrap items-end gap-2">
                        <MappingNameField
                          id={actionId}
                          name={action.name}
                          names={value.actions
                            .filter((_, i) => i !== index)
                            .map((entry) => entry.name)}
                          onChange={(name) =>
                            onChange(patchAction(value, index, { name }))
                          }
                        />
                        <BindingChrome
                          id={actionId}
                          index={index}
                          total={value.actions.length}
                          onMove={(delta) => {
                            setSelection({
                              kind: "action",
                              index: index + delta,
                            });
                            onChange({
                              ...value,
                              actions: moveItem(value.actions, index, delta),
                            });
                          }}
                          onRemove={() =>
                            onChange({
                              ...value,
                              actions: value.actions.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                          name={action.name || "action"}
                        />
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <div
                        className="text-sm font-medium"
                        data-testid={`${actionId}-bindings`}
                      >
                        Bindings
                      </div>
                      {action.bindings.map((binding, bindingIndex) => (
                        <ActionBindingRow
                          key={`${actionId}-binding-${bindingIndex}`}
                          id={`${actionId}-binding-${bindingIndex}`}
                          binding={binding}
                          index={bindingIndex}
                          total={action.bindings.length}
                          onChange={(next) => {
                            const bindings = [...action.bindings];
                            bindings[bindingIndex] = next;
                            onChange(patchAction(value, index, { bindings }));
                          }}
                          onMove={(delta) =>
                            onChange(
                              patchAction(value, index, {
                                bindings: moveItem(
                                  action.bindings,
                                  bindingIndex,
                                  delta,
                                ),
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
                        size="sm"
                        className="w-fit"
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
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>

          <>
            <div className="flex flex-col gap-3">
              {value.axes.map((axis, index) => {
                if (selected.kind !== "axis" || selected.index !== index)
                  return null;
                const axisId = `input-axis-${index}`;
                const kind = axis.kind === "2d" ? "2d" : "1d";
                return (
                  <Card key={axisId} size="sm" data-testid={axisId}>
                    <CardHeader className="border-b border-border">
                      <CardTitle>Axis</CardTitle>
                      <CardDescription>
                        Combine controls into a 1D value or a 2D direction.
                      </CardDescription>
                      <div className="flex flex-wrap items-end gap-2">
                        <MappingNameField
                          id={axisId}
                          name={axis.name}
                          names={value.axes
                            .filter((_, i) => i !== index)
                            .map((entry) => entry.name)}
                          onChange={(name) =>
                            onChange(patchAxis(value, index, { name }))
                          }
                        />
                        <Field>
                          <FieldLabel>Kind</FieldLabel>
                          <ToggleGroup
                            variant="outline"
                            size="sm"
                            className="pointer-coarse:[&>button]:min-h-11 pointer-coarse:[&>button]:min-w-11"
                            spacing={1}
                            value={[kind]}
                            onValueChange={(next) => {
                              const picked = next[0];
                              if (picked !== "1d" && picked !== "2d") return;
                              onChange(
                                patchAxis(value, index, { kind: picked }),
                              );
                            }}
                            aria-label="Axis Kind"
                          >
                            <ToggleGroupItem
                              value="1d"
                              data-testid={`${axisId}-kind-1d`}
                            >
                              1D
                            </ToggleGroupItem>
                            <ToggleGroupItem
                              value="2d"
                              data-testid={`${axisId}-kind-2d`}
                            >
                              2D
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </Field>
                        <BindingChrome
                          id={axisId}
                          index={index}
                          total={value.axes.length}
                          onMove={(delta) => {
                            setSelection({
                              kind: "axis",
                              index: index + delta,
                            });
                            onChange({
                              ...value,
                              axes: moveItem(value.axes, index, delta),
                            });
                          }}
                          onRemove={() =>
                            onChange({
                              ...value,
                              axes: value.axes.filter((_, i) => i !== index),
                            })
                          }
                          name={axis.name || "axis"}
                        />
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <div
                        className="text-sm font-medium"
                        data-testid={`${axisId}-bindings`}
                      >
                        Bindings
                      </div>
                      {axis.bindings.map((binding, bindingIndex) => (
                        <AxisBindingRow
                          key={`${axisId}-binding-${bindingIndex}`}
                          id={`${axisId}-binding-${bindingIndex}`}
                          binding={binding}
                          index={bindingIndex}
                          total={axis.bindings.length}
                          kind={kind}
                          onChange={(next) => {
                            const bindings = [...axis.bindings];
                            bindings[bindingIndex] = next;
                            onChange(patchAxis(value, index, { bindings }));
                          }}
                          onMove={(delta) =>
                            onChange(
                              patchAxis(value, index, {
                                bindings: moveItem(
                                  axis.bindings,
                                  bindingIndex,
                                  delta,
                                ),
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
                        size="sm"
                        className="w-fit"
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
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        </div>
      </div>
    </div>
  );
}
